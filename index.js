//================================================================================
// FILE 1: index.js (with serverUrl Fix)
// This version corrects the format of the serverUrl in the Vapi API call.
//================================================================================

const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const session = require('express-session');

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
async function callLlamaAPI(prompt, max_tokens = 150) {
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

// --- Email Body Parser ---
function getEmailBody(payload) {
    let combinedBody = '';
    const parts = [payload];
    while (parts.length) {
        const part = parts.shift();
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
            if (part.body && part.body.data) {
                const decoded = Buffer.from(part.body.data, 'base64').toString();
                combinedBody += (part.mimeType === 'text/html' ? decoded.replace(/<[^>]*>?/gm, ' ') : decoded) + '\n\n';
            }
        }
        if (part.parts) {
            parts.push(...part.parts);
        }
    }
    if (!combinedBody) combinedBody = payload.snippet || '';
    return combinedBody.replace(/\s+/g, ' ').trim();
}

// --- Gmail Search Logic ---
async function findInformationInGmail(authClient, vendor, userRequest) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });
    const searchQuery = `"${vendor}" in:inbox`;
    console.log(`Searching Gmail for: ${searchQuery}`);
    const res = await gmail.users.messages.list({ userId: 'me', q: searchQuery, maxResults: 500 });
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        return { needsSelection: false, phoneNumber: null, context: `I searched your emails for "${vendor}" but couldn't find any messages.` };
    }

    const emailProcessingPromises = messages.slice(0, 50).map(async (msg) => {
        try {
            const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const body = getEmailBody(messageDetails.data.payload);
            const subject = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';

            const relevancePrompt = `You are an expert relevance detection assistant. Your task is to determine if an email is a transactional message (like a receipt, order confirmation, shipping notice, or appointment detail) or if it is a promotional/marketing email.

Analyze the email based on the user's request, the email subject, and the email body.

User Request: "${userRequest}"
Email Subject: "${subject}"
Email Body (first 8000 chars):
"""
${body.substring(0, 8000)}
"""

Is this email directly relevant and actionable for the user's request?
- If the email is a transactional receipt, confirmation, or contains specific details like an Order ID, Reservation Number, or appointment time that relates to the request, respond with only the word: "Relevant".
- If the email is primarily a newsletter, an advertisement, a sale announcement, or any other form of marketing, respond with only the word: "Irrelevant".`;

            const relevance = await callLlamaAPI(relevancePrompt, 10);

            console.log(`Email Subject: "${subject}" -> Relevance: ${relevance}`);

            if (relevance.toLowerCase() === 'relevant') {
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
        return { needsSelection: true, choices: relevantEmails.slice(0, 5) };
    } else {
        return { needsSelection: false, context: `I found some emails from "${vendor}", but none seemed to be transactional or relevant to your request.` };
    }
}

// --- Get Email Details Logic ---
async function getEmailDetails(gmail, messageId, userRequest) {
    const neededInfoPrompt = `For a user request like "${userRequest}", what information would an assistant need to complete the task? List them separated by commas.`;
    const neededFields = await callLlamaAPI(neededInfoPrompt);
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId });
    const body = getEmailBody(msg.data.payload);
    const extractionPrompt = `From the email body below, extract the following fields: ${neededFields}. Format the output as a clean list, like "Key: Value". If a piece of information isn't found, state "Not Found".\n\nEmail Body: """${body}"""`;
    const extractedDetails = await callLlamaAPI(extractionPrompt, 250);
    const phonePrompt = `From the following text, extract any North American phone number you can find. Respond with only the number in E.164 format (e.g., +18005551234). If you don't find one, respond with "Not Found".\n\nText: """${body}"""`;
    let phoneNumberFromEmail = await callLlamaAPI(phonePrompt, 20);
    if (!phoneNumberFromEmail || !phoneNumberFromEmail.startsWith('+')) {
        phoneNumberFromEmail = null;
    }
    return { context: extractedDetails, phoneNumberFromEmail };
}

// --- Structured Summary Generation ---
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
    return await callLlamaAPI(summaryPrompt, 300);
}

// --- Derive Other Party Role ---
async function deriveOtherPartyRole(userRequest) {
    const rolePrompt = `Based on the user's request, what is the likely job title or role of the person the user wants to call? Respond with only the job title. Examples: "Customer Service Rep", "Receptionist", "Pharmacist".\n\nUser Request: "${userRequest}"`;
    return await callLlamaAPI(rolePrompt, 20);
}

// --- Express Routes ---
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
        const vendorPrompt = `If I want to "${req.body.userRequest}", what search query would you use to find the most relevant information from my gmail. respond with only the search query.`;
        const vendor = await callLlamaAPI(vendorPrompt, 6);
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
        // CORRECTED: serverUrl is now a simple string, as the Vapi API expects.
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
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.VAPI_PRIVATE_KEY}`},
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
