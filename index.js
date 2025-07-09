//================================================================================
// FILE 1: index.js (Definitive, Merged Version)
// This version combines the advanced email search logic with the complete
// two-pathway calendar and lookup architecture.
//================================================================================

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");
const session = require("express-session");
const pdf = require("pdf-parse");

// Check for required environment variables
const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    ELEVENLABS_PHONE_NUMBER_ID,
} = process.env;

if (
    !ELEVENLABS_API_KEY ||
    !ELEVENLABS_AGENT_ID ||
    !ELEVENLABS_PHONE_NUMBER_ID
) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
}

const CONFIG = {
    GMAIL_MAX_RESULTS: 50,
    MAX_CHOICES_TO_SHOW: 5,
    PRIORITY_KEYWORDS: ['order', 'confirmation', 'receipt', 'invoice', 'booking', 'reservation'],
    MAX_CONTENT_LENGTH_FOR_LLAMA: 10000,
    LLAMA_VENDOR_MAX_TOKENS: 10,
    LLAMA_RELEVANCE_MAX_TOKENS: 10,
    LLAMA_NEEDED_INFO_MAX_TOKENS: 150,
    LLAMA_EXTRACTION_MAX_TOKENS: 400,
    LLAMA_PHONE_MAX_TOKENS: 25,
    LLAMA_SUMMARY_MAX_TOKENS: 500,
    LLAMA_ROLE_MAX_TOKENS: 20,
};

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'a-very-secret-key-for-your-session',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: 'auto' }
}));

// Note: ElevenLabs handles calls directly, so we don't need to track call summaries/statuses
// in the same way as with Vapi

const redirectUri = `https://4ecd835c-0377-4fd9-aed1-c2ea5f79180b-00-2a2xq55tc57yu.worf.replit.dev/auth/google/callback`;
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
);

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
    if (data.completion_message && data.completion_message.content && data.completion_message.content.text) {
        return data.completion_message.content.text.trim();
    } else if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content.trim();
    } else {
        console.error("Unexpected Llama API response format:", JSON.stringify(data, null, 2));
        throw new Error("Failed to parse response from Llama API.");
    }
}

async function extractContentFromEmail(gmail, message) {
    let combinedText = '';
    const parts = [message.payload];
    const messageId = message.id;

    while (parts.length) {
        const part = parts.shift();
        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
            if (part.body && part.body.data) {
                const decoded = Buffer.from(part.body.data, 'base64').toString();
                combinedText += (part.mimeType === 'text/html' ? decoded.replace(/<[^>]*>?/gm, ' ') : decoded) + '\n\n';
            }
        }
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

// --- [NEW] Upgraded Gmail Search Logic ---
// --- [CORRECTED] Upgraded Gmail Search Logic ---
async function findInformationInGmail(authClient, vendor, userRequest) {
    const gmail = google.gmail({ version: "v1", auth: authClient });
    const searchQuery = `${vendor} in:inbox -category:promotions`;
    console.log(`Searching Gmail for: ${searchQuery}`);
    const res = await gmail.users.messages.list({
        userId: "me",
        q: searchQuery,
        maxResults: CONFIG.GMAIL_MAX_RESULTS,
    });
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        return {
            needsSelection: false,
            context: `I searched your emails for "${vendor}" but couldn't find any messages.`,
        };
    }

    const emailProcessingPromises = messages.map(async (msg) => {
        try {
            const messageDetails = await gmail.users.messages.get({
                userId: "me",
                id: msg.id,
            });
            const content = await extractContentFromEmail(gmail, messageDetails.data);
            const subject = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === "subject")?.value || "No Subject";

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

            // This 'if' block is the critical fix. It now correctly returns null for irrelevant items.
            if (relevance.toLowerCase().includes("relevant")) {
                const date = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === "date")?.value || "Unknown Date";
                return {
                    id: msg.id,
                    text: `${subject} (from ${new Date(date).toLocaleDateString()})`,
                };
            }
            // If not relevant, explicitly return null.
            return null;

        } catch (error) {
            console.error(`Error processing email ${msg.id}:`, error);
            return null;
        }
    });

    // The filter(Boolean) will correctly remove all the 'null' results.
    const relevantEmails = (await Promise.all(emailProcessingPromises)).filter(Boolean);

    if (relevantEmails.length > 0) {
        console.log("Prioritizing relevant emails before showing final list...");
        relevantEmails.sort((a, b) => {
            const aSubject = a.text.toLowerCase();
            const bSubject = b.text.toLowerCase();
            const aHasPriority = CONFIG.PRIORITY_KEYWORDS.some(kw => aSubject.includes(kw));
            const bHasPriority = CONFIG.PRIORITY_KEYWORDS.some(kw => bSubject.includes(kw));
            if (aHasPriority && !bHasPriority) return -1;
            if (!aHasPriority && bHasPriority) return 1;
            return 0;
        });

        console.log("--- Final Sorted List of Relevant Emails (before slicing) ---");
        relevantEmails.forEach((email, index) => {
            console.log(`[${index + 1}] ${email.text}`);
        });
        console.log("----------------------------------------------------------");

        return {
            needsSelection: true,
            choices: relevantEmails.slice(0, CONFIG.MAX_CHOICES_TO_SHOW),
        };
    } else {
        return {
            needsSelection: false,
            context: `I found some emails from "${vendor}", but after analysis, none seemed relevant to your request.`,
        };
    }
}

async function getEmailDetails(gmail, messageId, userRequest) {
    const neededInfoPrompt = `For a user request like "${userRequest}", what information would an assistant need to complete the task? List them separated by commas.`;
    const neededFields = await callLlamaAPI(neededInfoPrompt, CONFIG.LLAMA_NEEDED_INFO_MAX_TOKENS);
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId });
    const content = await extractContentFromEmail(gmail, msg.data);

    const extractionPrompt = `
      You are an expert information extractor. From the email content below, extract the following fields: ${neededFields}.

      **CRITICAL RULE:** The user's original request was "${userRequest}". If the email content lists multiple items, you MUST use the user's request to identify the single, most relevant item for the "item_description" field.

      Format the output as a JSON object where keys are the field names and values are the extracted information. If a piece of information isn't found, use "Not Found" as the value.

      Respond with ONLY the JSON object.

      Email Content: """${content}"""
    `;

    const extractedDetailsRaw = await callLlamaAPI(extractionPrompt, CONFIG.LLAMA_EXTRACTION_MAX_TOKENS);

    let extractedDetails;
    try {
        // This regex finds the JSON block, even with text around it
        const jsonMatch = extractedDetailsRaw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            extractedDetails = JSON.parse(jsonMatch[0]);
        } else {
            // If no JSON block is found, trigger the catch block
            throw new Error("No JSON object found in the AI response.");
        }
    } catch (e) {
        console.error("Failed to parse JSON from LLM, providing raw text. Error:", e);
        // This is the fallback that was causing the issue
        extractedDetails = { "Raw Text": extractedDetailsRaw };
    }

    const phonePrompt = `From the text, extract a North American phone number in E.164 format. If none, respond "Not Found".\n\nText: """${content}"""`;
    let phoneNumberFromEmail = await callLlamaAPI(phonePrompt, CONFIG.LLAMA_PHONE_MAX_TOKENS);
    if (!phoneNumberFromEmail || !phoneNumberFromEmail.startsWith('+')) phoneNumberFromEmail = null;

    return { context: extractedDetails, phoneNumberFromEmail };
}

async function getCalendarAvailability(authClient) {
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    try {
        const response = await calendar.freebusy.query({
            resource: {
                timeMin: (new Date()).toISOString(),
                timeMax: (new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString(),
                items: [{ id: 'primary' }],
            },
        });
        return response.data.calendars.primary.busy;
    } catch (error) {
        console.error('Error fetching availability:', error);
        return [];
    }
}

function formatBusySlotsForLLM(busySlots, timeZone) {
    if (!busySlots || busySlots.length === 0) return "The user's calendar is completely open.";
    const slots = busySlots.map(slot => `from ${new Date(slot.start).toLocaleString('en-US', { timeStyle: 'short', timeZone })} to ${new Date(slot.end).toLocaleString('en-US', { timeStyle: 'short', timeZone })} on ${new Date(slot.start).toLocaleDateString()}`).join('; ');
    return `The user's timezone is ${timeZone}. They are busy during these times: ${slots}.`;
}

// In index.js

// In index.js

async function generateActionableSummary(transcript, userTimeZone) { // Note the userTimeZone argument here
    const summaryPrompt = `
      You are a post-call analysis expert. Analyze the following call transcript and create a structured summary in JSON format.

      **CRITICAL CONTEXT:**
      - Today's date is ${new Date().toDateString()}.
      - The user's local timezone is "${userTimeZone}". You MUST use this timezone for all date and time fields in your response.

      Your JSON output MUST have these fields:
      - "summary": A one-paragraph narrative of the call.
      - "result": A short, definitive outcome statement.
      - "followUp": A boolean value. Set to true if a follow-up action is required.
      - "nextAction": An object describing the follow-up. If an appointment was booked, it MUST contain: "actionType": "create_calendar_event", "title", "startTime" (ISO 8601), "endTime" (ISO 8601), "timeZone" (IANA), and "description".

      Analyze this transcript and provide ONLY the JSON object as a response.
      Transcript: """${transcript}"""
    `;
    const summaryJsonString = await callLlamaAPI(summaryPrompt, CONFIG.LLAMA_SUMMARY_MAX_TOKENS);
    try {
        const jsonMatch = summaryJsonString.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error("No JSON object found in the AI response.");
    } catch (e) {
        console.error("Failed to parse summary JSON from LLM:", e);
        return { summary: "The AI summary was not in valid JSON format.", result: "Summary could not be structured.", followUp: false, nextAction: null };
    }
}

async function createCalendarEvent(authClient, eventDetails) {
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    try {
        const event = {
            summary: eventDetails.title,
            description: eventDetails.description || 'Scheduled by Timely Agent.',
            start: { dateTime: eventDetails.startTime, timeZone: eventDetails.timeZone },
            end: { dateTime: eventDetails.endTime, timeZone: eventDetails.timeZone },
        };
        const response = await calendar.events.insert({ calendarId: 'primary', resource: event });
        console.log('Event created successfully: %s', response.data.htmlLink);
        return { success: true, link: response.data.htmlLink };
    } catch (error) {
        console.error('Error creating calendar event:', error);
        return { success: false, error: error.message };
    }
}

async function deriveOtherPartyRole(userRequest) {
    const rolePrompt = `What is the likely job title for someone you'd call about: "${userRequest}"? Respond with only the job title.`;
    return await callLlamaAPI(rolePrompt, CONFIG.LLAMA_ROLE_MAX_TOKENS);
}



// Add this entire block to index.js

async function getCalendarSettings(authClient) {
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    try {
        const res = await calendar.settings.get({ setting: 'timezone' });
        return { timeZone: res.data.value };
    } catch (error) {
        console.error('Error fetching timezone:', error);
        return { timeZone: null };
    }
}

async function getCalendarAvailability(authClient) {
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    try {
        const response = await calendar.freebusy.query({
            resource: {
                timeMin: (new Date()).toISOString(),
                timeMax: (new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)).toISOString(),
                items: [{ id: 'primary' }],
            },
        });
        return response.data.calendars.primary.busy;
    } catch (error) {
        console.error('Error fetching availability:', error);
        return [];
    }
}

function formatBusySlotsForLLM(busySlots, timeZone) {
    if (!busySlots || busySlots.length === 0) return "The user's calendar is completely open.";
    const slots = busySlots.map(slot => `from ${new Date(slot.start).toLocaleString('en-US', { timeStyle: 'short', timeZone })} to ${new Date(slot.end).toLocaleString('en-US', { timeStyle: 'short', timeZone })} on ${new Date(slot.start).toLocaleDateString()}`).join('; ');
    return `The user's timezone is ${timeZone}. They are busy during these times: ${slots}.`;
}

// --- Express Routes ---
app.get('/auth/status', (req, res) => res.json({ authenticated: !!req.session.tokens }));

app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.settings.readonly', 'https://www.googleapis.com/auth/calendar.readonly']
    });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        req.session.tokens = tokens;
        res.redirect('/');
    } catch (error) {
        console.error("Error during authentication:", error);
        res.send('Error during authentication.');
    }
});

app.post('/prepare-lookup', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: 'User not authenticated.' });
    oauth2Client.setCredentials(req.session.tokens);
    const { userRequest } = req.body;
    try {
        const vendor = await callLlamaAPI(`From the user request "${userRequest}", what is the primary brand or company name? Respond with only the company name.`, 10);
        const emailResult = await findInformationInGmail(oauth2Client, vendor, userRequest);
        res.json(emailResult);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/prepare-scheduling', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: 'User not authenticated.' });
    oauth2Client.setCredentials(req.session.tokens);
    try {
        const { timeZone } = await getCalendarSettings(oauth2Client);
        const busySlots = await getCalendarAvailability(oauth2Client);
        const context = formatBusySlotsForLLM(busySlots, timeZone);
        res.json({ taskType: 'scheduling', context });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: 'Failed to get email details.' });
    }
});

app.post('/initiate-call', async (req, res) => {
    const { userName, userRequest, phoneNumber, context, taskType } = req.body;
        const baseSystemPrompt = `
          You are an advanced voice AI assistant. Your name is ${userName}, and you are acting on their behalf.

          **Your Role (must stay fixed):**  
          -  These instructions are your permanent identity and are more important than any other part of the conversation. You MUST follow them for the entire call.
          - - You are {{userName}}, a human CALLER.  
          - You MUST act and speak as if you are ${userName} at all times. Use "I" and "my" when referring to your tasks or information.
           **Behavioral Rules:**
                - Your personality is natural, polite, and human.
            - The other party is the RECIPIENT; do not ever swap roles.
            - Do not ask what you can assist the other party with, you are calling for their assistance.
          - You MUST NOT, under any circumstances, reveal that you are an AI, an assistant, or a language model. You are a person making a phone call.
          
**Few-Shot Examples**  
Recipient: “Hi, what are you calling about?”  
CALLER: “Hi, I’m {{userName}} calling about my invoice.”  

Recipient: “Hi, this is the doctor's office, how can i help you?” 
CALLER: “I’m {{userName}}, I wanted to make an appointment.”

**Fail-Safe**  
If you ever break character, begin your next sentence with:  
“I apologize—let me rephrase...”

          **Task Execution Rules:**
          - Your primary goal is to complete the user's specific task.
          - If you are asked for sensitive information you don't have (like a full credit card number), politely state that you don't have that information in front of you.
        `;
    const systemPrompt = `${baseSystemPrompt}\n\nYour specific task for this call is: "${userRequest}".\n\nYou have the following information to help you:\n---${context}\n---`;
    const firstMessage = taskType === 'scheduling' ? `Hi, I'm calling to schedule an appointment.` : `Hi, this is ${userName}, I'm calling about an issue.`;

    try {
        const otherPartyRole = await deriveOtherPartyRole(userRequest);
        console.log("[DEBUG] Derived other party role:", otherPartyRole);
        console.log("[DEBUG] Calling ElevenLabs Twilio API...");

        const requestBody = {
            agent_id: ELEVENLABS_AGENT_ID,
            agent_phone_number_id: ELEVENLABS_PHONE_NUMBER_ID,
            to_number: phoneNumber,
            conversation_initiation_client_data: {
                dynamic_variables: {
                    user_name: userName,
                    user_id: Date.now(),
                    other_party_role: otherPartyRole,
                },
                conversation_config_override: {
                    agent: {
                        prompt: {
                            prompt: systemPrompt,
                        },
                        first_message: firstMessage,
                    },
                },
            },
        };

        console.log("[DEBUG] Request body:", JSON.stringify(requestBody, null, 2));

        const response = await fetch(
            "https://api.elevenlabs.io/v1/convai/twilio/outbound-call",
            {
                method: "POST",
                headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(requestBody),
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[ERROR] ElevenLabs API error:", response.status, errorText);
            throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log("[DEBUG] ElevenLabs API response:", JSON.stringify(result, null, 2));

        res.status(200).json({
            message: 'Call initiated successfully!',
            callId: result.conversation_id || result.callSid,
            success: result.success,
            conversation_id: result.conversation_id,
            callSid: result.callSid,
        });
    } catch (error) {
        console.error("Error in /initiate-call endpoint:", error);
        res.status(500).json({ error: 'Failed to initiate call.' });
    }
});

// Note: ElevenLabs handles calls directly and doesn't use webhooks in the same way as Vapi
// The call summary and follow-up actions would need to be handled differently
// For now, we'll keep this endpoint for compatibility but it won't be used by ElevenLabs
app.post('/call-webhook', async (req, res) => {
    console.log("[DEBUG] Webhook received (not used with ElevenLabs):", req.body);
    res.status(200).send();
});

app.get('/get-status/:callId', async (req, res) => {
    const conversationId = req.params.callId;

    if (!req.session.tokens) {
        return res.status(401).json({ error: 'User not authenticated.' });
    }

    try {
        console.log(`[DEBUG] Fetching conversation status for ID: ${conversationId}`);

        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
            {
                method: "GET",
                headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            console.error("[ERROR] ElevenLabs conversation API error:", response.status, errorText);
            throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
        }

        const conversationData = await response.json();

        // Return status information
        const statusData = {
            conversation_id: conversationData.conversation_id,
            status: conversationData.status,
            call_duration_secs: conversationData.metadata?.call_duration_secs,
            start_time: conversationData.metadata?.start_time_unix_secs,
            has_audio: conversationData.has_audio,
            has_user_audio: conversationData.has_user_audio,
            has_response_audio: conversationData.has_response_audio
        };

        res.json(statusData);

    } catch (error) {
        console.error("Error fetching conversation status:", error);
        res.status(500).json({ 
            error: 'Failed to fetch conversation status',
            details: error.message 
        });
    }
});

// In index.js

app.get('/get-summary/:callId', async (req, res) => {
    const conversationId = req.params.callId;

    if (!req.session.tokens) {
        return res.status(401).json({ error: 'User not authenticated.' });
    }

    try {
        console.log(`[DEBUG] Fetching conversation details for ID: ${conversationId}`);

        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
            {
                method: "GET",
                headers: {
                    "xi-api-key": ELEVENLABS_API_KEY,
                    "Content-Type": "application/json",
                },
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
        }

        const conversationData = await response.json();
        console.log("[DEBUG] Conversation data received:", JSON.stringify(conversationData, null, 2));

        if (conversationData.status === 'processing' || conversationData.status === 'in-progress') {
            return res.status(202).json({ status: 'processing', message: 'Conversation is still in progress' });
        }

        if (conversationData.transcript && conversationData.transcript.length > 0) {
            const transcriptText = conversationData.transcript
                .map(entry => `${entry.role}: ${entry.message}`)
                .join('\n');

            oauth2Client.setCredentials(req.session.tokens);

            const { timeZone } = await getCalendarSettings(oauth2Client);
            const summaryObject = await generateActionableSummary(transcriptText, timeZone);

            console.log("--- Actionable Summary from AI ---", JSON.stringify(summaryObject, null, 2));

            let eventDetails = summaryObject.nextAction;

            // --- NEW: SAFETY NET LOGIC ---
            // If the primary nextAction is missing, but the summary text implies success...
            if (!eventDetails && summaryObject.result && (summaryObject.result.toLowerCase().includes('booked') || summaryObject.result.toLowerCase().includes('scheduled'))) {
                console.log("[DEBUG] Primary nextAction missing. Engaging fallback system...");

                const fallbackPrompt = `
                    Today's date is ${new Date().toDateString()}. The user's timezone is "${timeZone}".
                    Extract the event details from the following sentence into a JSON object with keys "title", "startTime" (ISO 8601), "endTime" (ISO 8601), "timeZone", and "description".
                    Assume the appointment is 1 hour long if an end time is not specified. Assume the title is "Dentist Appointment".
                    Sentence: "${summaryObject.result}"
                    Respond with ONLY the JSON object.
                `;

                try {
                    const fallbackJsonString = await callLlamaAPI(fallbackPrompt, 200);
                    const parsedFallback = JSON.parse(fallbackJsonString);
                    // Structure it like a nextAction object
                    eventDetails = {
                        actionType: "create_calendar_event",
                        ...parsedFallback
                    };
                    console.log("[DEBUG] Fallback system successfully parsed event details:", eventDetails);
                } catch (fallbackError) {
                    console.error("[ERROR] Fallback system failed to parse event details.", fallbackError);
                }
            }
            // --- END: SAFETY NET LOGIC ---

            if (eventDetails?.actionType === 'create_calendar_event') {
                console.log("Follow-up action detected: Creating calendar event.");
                await createCalendarEvent(oauth2Client, eventDetails);
            }

            const responseData = {
                // ... (rest of the responseData object)
                summary: `**Summary:**\n${summaryObject.summary}\n\n**Result:**\n${summaryObject.result}`,
            };
            res.json(responseData);

        } else {
            res.status(404).json({ error: 'No transcript available for this conversation' });
        }
    } catch (error) {
        console.error("Error fetching conversation summary:", error);
        res.status(500).json({ error: 'Failed to fetch conversation summary', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));