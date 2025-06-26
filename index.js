//================================================================================
// FILE 1: index.js (with Full Results Logging)
// This version logs the complete sorted list of relevant emails for debugging.
//================================================================================

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const session = require('express-session');
const pdf = require('pdf-parse');

const CONFIG = {
    // Gmail search settings
    GMAIL_MAX_RESULTS: 50,
    MAX_CHOICES_TO_SHOW: 5,
    // Emails with these keywords will be moved to the top of the choices list.
    PRIORITY_KEYWORDS: ['order', 'confirmation', 'receipt', 'invoice', 'booking', 'reservation'],

    // Llama API settings
    MAX_CONTENT_LENGTH_FOR_LLAMA: 10000,
    LLAMA_VENDOR_MAX_TOKENS: 10,
    LLAMA_RELEVANCE_MAX_TOKENS: 10,
    LLAMA_NEEDED_INFO_MAX_TOKENS: 150,
    LLAMA_EXTRACTION_MAX_TOKENS: 400,
    LLAMA_PHONE_MAX_TOKENS: 25,
    LLAMA_SUMMARY_MAX_TOKENS: 300,
    LLAMA_ROLE_MAX_TOKENS: 20,
};

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// --- Session Setup ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-secret-key-for-your-session',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: 'auto' }
}));

// --- In-memory storage ---
const callSummaries = {};
const callStatuses = {};

// --- Google OAuth2 Setup ---
const redirectUri = `https://e6722321-658b-4b05-959d-087e331913bf-00-ezw3nlpl0h7j.picard.replit.dev/auth/google/callback`;
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
);

// --- Rate Limiter for Llama API ---
class RateLimiter {
    constructor(maxRequests, timeWindow) {
        this.maxRequests = maxRequests;
        this.timeWindow = timeWindow;
        this.requests = [];
    }
    async waitForSlot() {
        const now = Date.now();
        this.requests = this.requests.filter(time => now - time < this.timeWindow);
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = this.timeWindow - (now - oldestRequest);
            console.log(`Rate limit hit, waiting ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.requests.push(now);
    }
}
const llamaRateLimiter = new RateLimiter(50, 1000);

// --- Llama API Helper ---
async function callLlamaAPI(prompt, max_tokens = CONFIG.LLAMA_NEEDED_INFO_MAX_TOKENS) {
    await llamaRateLimiter.waitForSlot();
    if (!process.env.LLAMA_API_KEY || !process.env.LLAMA_API_URL) {
        throw new Error("Llama API Key or URL is not configured in Secrets.");
    }
    const response = await fetch(process.env.LLAMA_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.LLAMA_API_KEY}`
        },
        body: JSON.stringify({
            model: "Llama-3.3-70B-Instruct",
            messages: [{ role: "system", content: prompt }],
            temperature: 0.1,
            max_tokens: max_tokens,
        })
    });
    if (!response.ok) {
        const errorText = await response.text();
        console.error("Llama API Error Response:", errorText);
        throw new Error(`Llama API Error: ${errorText}`);
    }
    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content.trim();
    } else if (data.completion_message && data.completion_message.content && data.completion_message.content.text) {
        return data.completion_message.content.text.trim();
    } else {
        console.error("Unexpected Llama API response format:", JSON.stringify(data, null, 2));
        throw new Error("Failed to parse response from Llama API.");
    }
}


// This function now extracts text from the body AND any PDF attachments.
async function extractContentFromEmail(gmail, message) {
    let combinedText = '';
    const parts = [message.payload];
    const messageId = message.id;

    while (parts.length) {
        const part = parts.shift();

        // Extract from text/html or text/plain
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
            if (part.body && part.body.data) {
                const decoded = Buffer.from(part.body.data, 'base64').toString();
                combinedText += (part.mimeType === 'text/html' ? decoded.replace(/<[^>]*>?/gm, ' ') : decoded) + '\n\n';
            }
        }

        // Check for and extract from PDF attachments
        if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
            console.log(`Found PDF attachment: ${part.filename}`);
            const attachmentId = part.body.attachmentId;
            if (attachmentId) {
                try {
                    const attachment = await gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: messageId,
                        id: attachmentId,
                    });
                    const pdfBuffer = Buffer.from(attachment.data.data, 'base64');
                    const data = await pdf(pdfBuffer);
                    combinedText += `\n\n--- Start of PDF Content: ${part.filename} ---\n`;
                    combinedText += data.text;
                    combinedText += `\n--- End of PDF Content: ${part.filename} ---\n\n`;
                } catch (pdfError) {
                    console.error(`Failed to parse PDF ${part.filename}:`, pdfError);
                    combinedText += `\n\n[Could not parse PDF: ${part.filename}]\n\n`;
                }
            }
        }

        if (part.parts) {
            parts.push(...part.parts);
        }
    }

    if (!combinedText) combinedText = message.payload.snippet || '';
    return combinedText.replace(/\s+/g, ' ').trim();
}

// --- Gmail Search Logic ---
async function findInformationInGmail(authClient, vendor, userRequest) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });
    const searchQuery = `${vendor} in:inbox -category:promotions`;
    console.log(`Searching Gmail for: ${searchQuery}`);
    const res = await gmail.users.messages.list({ userId: 'me', q: searchQuery, maxResults: CONFIG.GMAIL_MAX_RESULTS });
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        return { needsSelection: false, phoneNumber: null, context: `I searched your emails for "${vendor}" but couldn't find any messages.` };
    }

    const emailProcessingPromises = messages.map(async (msg) => {
        try {
            const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const content = await extractContentFromEmail(gmail, messageDetails.data);
            const subject = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';

            const relevancePrompt = `You are an expert relevance detection assistant. Your primary task is to identify transactional emails and ignore marketing/promotional content.

A transactional email contains specific, non-promotional information about a user's action, such as an order confirmation, receipt, shipping notice, or appointment detail.

CRITERIA: Analyze the email's subject and content. If you find specific transactional data like an "Order Number", "Order ID", "Receipt for your purchase", "Your order has shipped", or "Your appointment is confirmed", you MUST classify it as "Relevant".

The presence of marketing material (like ads or "you might also like" sections) does NOT make an email irrelevant if it also contains the core transactional data mentioned above.

User Request: "${userRequest}"
Email Subject: "${subject}"
Email Content (first ${CONFIG.MAX_CONTENT_LENGTH_FOR_LLAMA} chars):
"""
${content.substring(0, CONFIG.MAX_CONTENT_LENGTH_FOR_LLAMA)}
"""

Based on these rules, is this email transactional and relevant? Respond with only the single word: "Relevant" or "Irrelevant".`;

            const relevance = await callLlamaAPI(relevancePrompt, CONFIG.LLAMA_RELEVANCE_MAX_TOKENS);

            console.log(`Email Subject: "${subject}" -> Relevance: ${relevance}`);

            if (relevance.toLowerCase().includes('relevant')) {
                const date = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'date')?.value || 'Unknown Date';
                return { id: msg.id, text: `${subject} (from ${new Date(date).toLocaleDateString()})` };
            }
            return null;
        } catch (error) {
            console.error(`Error processing email ${msg.id}:`, error);
            return null;
        }
    });

    const results = await Promise.all(emailProcessingPromises);
    const relevantEmails = results.filter(email => email !== null);

    if (relevantEmails.length > 0) {
        // Sort the relevant emails to prioritize certain keywords
        console.log("Prioritizing relevant emails before showing final list...");
        relevantEmails.sort((a, b) => {
            const aSubject = a.text.toLowerCase();
            const bSubject = b.text.toLowerCase();
            const aHasPriority = CONFIG.PRIORITY_KEYWORDS.some(kw => aSubject.includes(kw));
            const bHasPriority = CONFIG.PRIORITY_KEYWORDS.some(kw => bSubject.includes(kw));

            if (aHasPriority && !bHasPriority) return -1; // a comes first
            if (!aHasPriority && bHasPriority) return 1;  // b comes first
            return 0; // maintain original order otherwise
        });

        // NEW: Log the full sorted list for debugging
        console.log("--- Final Sorted List of Relevant Emails (before slicing) ---");
        relevantEmails.forEach((email, index) => {
            console.log(`[${index + 1}] ${email.text}`);
        });
        console.log("----------------------------------------------------------");

        return { needsSelection: true, choices: relevantEmails.slice(0, CONFIG.MAX_CHOICES_TO_SHOW) };
    } else {
        return { needsSelection: false, context: `I found some emails from "${vendor}", but after analysis, none seemed relevant to your request.` };
    }
}

// --- Get Email Details Logic ---
async function getEmailDetails(gmail, messageId, userRequest) {
    const neededInfoPrompt = `For a user request like "${userRequest}", what information would an assistant need to complete the task? List them separated by commas.`;
    const neededFields = await callLlamaAPI(neededInfoPrompt, CONFIG.LLAMA_NEEDED_INFO_MAX_TOKENS);
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId });

    // Using the new function to get text from body AND PDFs for detailed extraction.
    const content = await extractContentFromEmail(gmail, msg.data);

    const extractionPrompt = `From the email content below, extract the following fields: ${neededFields}. The content may include text from the email body and from PDF attachments. Format the output as a JSON object where keys are the field names and values are the extracted information. If a piece of information isn't found, use "Not Found" as the value. Respond with ONLY the JSON object.\n\nEmail Content: """${content}"""`;
    let extractedDetailsRaw = await callLlamaAPI(extractionPrompt, CONFIG.LLAMA_EXTRACTION_MAX_TOKENS);

    // Sanitize and parse the JSON
    let extractedDetails;
    try {
        extractedDetailsRaw = extractedDetailsRaw.replace(/```json|```/gi, '').trim();
        extractedDetails = JSON.parse(extractedDetailsRaw);
    } catch (e) {
        console.error("Failed to parse JSON from LLM, returning raw text.", e);
        extractedDetails = { "Raw Text": extractedDetailsRaw };
    }

    const phonePrompt = `From the following text, extract any North American phone number you can find. Respond with only the number in E.164 format (e.g., +18005551234). If you don't find one, respond with "Not Found".\n\nText: """${content}"""`;
    let phoneNumberFromEmail = await callLlamaAPI(phonePrompt, CONFIG.LLAMA_PHONE_MAX_TOKENS);
    if (!phoneNumberFromEmail || !phoneNumberFromEmail.startsWith('+')) {
        phoneNumberFromEmail = null;
    }
    return { context: extractedDetails, phoneNumberFromEmail };
}


// --- Structured Summary Generation (No changes needed here) ---
async function generateDetailedSummary(transcript, userName, otherPartyRole) {
    if (!transcript) return "Call ended, but no transcript was available to generate a summary.";
    const summaryPrompt = `
      Analyze the following call transcript. The agent, acting as "${userName}", called a business. The other party is the "${otherPartyRole}".

      Your task is to provide a concise, easily digestible summary with three distinct sections using Markdown for formatting:

      1.  **Summary:** Write a short, narrative summary of the call. Describe what ${userName} wanted, what the ${otherPartyRole} said, and the general flow of the conversation.
      2.  **Result:** State the final, definitive outcome of the call (e.g., "Return successfully initiated," "Appointment booked for Friday at 3 PM," "Could not resolve issue").
      3.  **Follow-up Needed:** List any actions that need to be taken or information that is still required. If no follow-up is needed, state "None."

      Transcript:
      """
      ${transcript}
      """
    `;
    return await callLlamaAPI(summaryPrompt, CONFIG.LLAMA_SUMMARY_MAX_TOKENS);
}

// --- Derive Other Party Role (No changes needed here) ---
async function deriveOtherPartyRole(userRequest) {
    const rolePrompt = `Based on the user's request, what is the likely job title or role of the person the user wants to call? Respond with only the job title. Examples: "Customer Service Rep", "Receptionist", "Pharmacist".\n\nUser Request: "${userRequest}"`;
    return await callLlamaAPI(rolePrompt, CONFIG.LLAMA_ROLE_MAX_TOKENS);
}


// --- Express Routes (No changes needed here) ---
app.get('/auth/status', (req, res) => res.json({ authenticated: !!req.session.tokens }));

app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.readonly'] });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        req.session.tokens = tokens;
        res.redirect('/');
    } catch (error) { res.send('Error during authentication.'); }
});

app.post('/search-email', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: 'User not authenticated.' });
    oauth2Client.setCredentials(req.session.tokens);
    try {
        const vendorPrompt = `From the user request "${req.body.userRequest}", what is the primary brand or company name? Respond with only the company name.`;
        const vendor = await callLlamaAPI(vendorPrompt, CONFIG.LLAMA_VENDOR_MAX_TOKENS);
        const emailResult = await findInformationInGmail(oauth2Client, vendor, req.body.userRequest);
        res.status(200).json(emailResult);
    } catch (error) {
        console.error("Error in /search-email endpoint:", error);
        res.status(500).json({ error: 'Failed to search email.' });
    }
});

app.post('/get-email-details', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: 'User not authenticated.' });
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    try {
        const details = await getEmailDetails(gmail, req.body.messageId, req.body.userRequest);
        res.status(200).json(details);
    } catch (error) {
        console.error("Error in /get-email-details endpoint:", error);
        res.status(500).json({ error: 'Failed to get email details.' });
    }
});

app.post('/initiate-call', async (req, res) => {
    const { userName, userRequest, phoneNumber, context } = req.body;
    const baseSystemPrompt = `You are acting as ${userName}. Your voice and personality should be natural and conversational, just like a real person making a phone call. Do not mention that you are an AI or an assistant.
- If you are asked for sensitive information you do not have (like a full credit card number or a password), politely state that you do not have it in front of you for security reasons.
- Use the 'sendDTMF' tool to navigate any automated phone menus you encounter. Be precise and only press the numbers you are instructed to.
- If the other side asks you to repeat information, do it slower than the last time.
- ask them to trigger a proof of the accomplished tasks to your email.
- Once the task is complete, end the call politely.`;
    const systemPrompt = `${baseSystemPrompt}\n\nYour specific task for this call is: "${userRequest}".\n\nYou have the following information to help you:\n---${context}\n---`;

    try {
        const otherPartyRole = await deriveOtherPartyRole(userRequest);
        const payload = {
            phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
            customer: { number: phoneNumber },
            assistant: {
                serverUrl: `https://${req.get('host')}/call-webhook`,
                firstMessage: `Hi, this is ${userName}. I'm calling about an issue I need help with.`,
                model: {
                    provider: "openai",
                    model: "gpt-4o",
                    systemPrompt: systemPrompt,
                    tools: [{
                        type: "function",
                        function: {
                            name: "sendDTMF",
                            description: "Sends a DTMF tone during the call to navigate phone menus.",
                            parameters: { type: "object", properties: { digit: { type: "string" } } }
                        }
                    }]
                },
                voice: { provider: "playht", voiceId: "jennifer" },
                metadata: { userName: userName, otherPartyRole: otherPartyRole }
            }
        };

        const vapiResponse = await fetch('https://api.vapi.ai/call/phone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}` },
            body: JSON.stringify(payload)
        });

        if (!vapiResponse.ok) {
            const errorData = await vapiResponse.json();
            throw new Error(`Vapi API Error: ${JSON.stringify(errorData.message || errorData)}`);
        }
        const call = await vapiResponse.json();
        res.status(200).json({ message: 'Call initiated successfully!', callId: call.id });
    } catch (error) {
        console.error("Error in /initiate-call endpoint:", error);
        res.status(500).json({ error: 'Failed to initiate call.' });
    }
});

app.post('/stop-call', async (req, res) => {
    const { callId } = req.body;
    if (!callId) return res.status(400).json({ error: 'callId is required.' });
    try {
        await fetch(`https://api.vapi.ai/call/${callId}/stop`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}` }
        });
        res.status(200).json({ message: 'Call stop request sent successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to stop call.' });
    }
});

app.post('/call-webhook', async (req, res) => {
    const { message } = req.body;
    if (!message || !message.call) return res.status(200).send();
    const callId = message.call.id;
    if (message.type === 'end-of-call-report') {
        const transcript = message.transcript || "No transcript available.";
        const userName = message.call.assistant.metadata.userName || 'The User';
        const otherPartyRole = message.call.assistant.metadata.otherPartyRole || 'The Other Party';
        console.log(`Call ended: ${callId}. Generating structured summary...`);
        const summary = await generateDetailedSummary(transcript, userName, otherPartyRole);
        callSummaries[callId] = summary;
        delete callStatuses[callId];
    } else if (message.type === 'status-update') {
        callStatuses[callId] = `Call status: ${message.status}...`;
    } else if (message.type === 'transcript' && message.transcriptType === 'final') {
        if (message.role === 'assistant') {
            callStatuses[callId] = `${message.call.assistant.metadata.userName || 'Agent'} is speaking...`;
        } else if (message.role === 'user' && message.transcript) {
            callStatuses[callId] = `Them: "${message.transcript}"`;
        }
    }
    res.status(200).send();
});

app.get('/get-status/:callId', (req, res) => {
    res.status(200).json({ status: callStatuses[req.params.callId] || null });
});

app.get('/get-summary/:callId', (req, res) => {
    const summary = callSummaries[req.params.callId];
    if (summary) {
        res.status(200).json({ summary });
        delete callSummaries[req.params.callId];
    } else { res.status(202).send(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));