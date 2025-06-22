//================================================================================
// FILE 1: index.js (with Real Vapi Call Logic)
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

class TokenRateLimiter {
    constructor(maxTokens, timeWindow) {
        this.maxTokens = maxTokens;
        this.timeWindow = timeWindow;
        this.tokenUsage = [];
    }

    async waitForTokens(estimatedTokens) {
        const now = Date.now();
        this.tokenUsage = this.tokenUsage.filter(usage => now - usage.timestamp < this.timeWindow);
        
        const currentUsage = this.tokenUsage.reduce((sum, usage) => sum + usage.tokens, 0);
        
        if (currentUsage + estimatedTokens > this.maxTokens) {
            const oldestUsage = this.tokenUsage[0];
            const waitTime = this.timeWindow - (now - oldestUsage.timestamp);
            console.log(`Token limit hit, waiting ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            // Recursive call after waiting
            return this.waitForTokens(estimatedTokens);
        }
        
        this.tokenUsage.push({ tokens: estimatedTokens, timestamp: now });
    }
}

const llamaRateLimiter = new RateLimiter(50, 1000); // 50 requests per second (3000 per minute)
const tokenRateLimiter = new TokenRateLimiter(1000000, 60000); // 1M tokens per minute

// --- Llama API Helper ---
async function callLlamaAPI(prompt, max_tokens = 150) {
    // Estimate tokens (rough approximation: 1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil((prompt.length + max_tokens) / 4);
    
    // Wait for both rate limit slots
    await llamaRateLimiter.waitForSlot();
    await tokenRateLimiter.waitForTokens(estimatedTokens);

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
    console.log(`Executing broad Gmail search with query: ${searchQuery}`);

    const res = await gmail.users.messages.list({ userId: 'me', q: searchQuery, maxResults: 50 }); 
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        return { needsSelection: false, context: `I searched your emails for "${vendor}" but couldn't find any messages.` };
    }

    // Process emails in parallel with rate limiting
    const emailProcessingPromises = messages.slice(0, 50).map(async (msg) => {
        try {
            const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.id });
            const body = getEmailBody(messageDetails.data.payload);

            const cleaningPrompt = `Parse the following raw email text and extract only the core, human-readable message. Remove all irrelevant information like email headers, navigation links, marketing footers, and legal disclaimers. Return only the clean text.\n\nRaw Text: """${body.substring(0, 8000)}"""`;
            const cleanedBody = await callLlamaAPI(cleaningPrompt, 500);

            const relevancePrompt = `Is the following email body likely to contain actionable, transactional information (like an order, a booking, or a receipt) related to this user request: "${userRequest}"? Respond with only "Relevant" or "Irrelevant".\n\nEmail Body: """${cleanedBody}"""`;
            const relevance = await callLlamaAPI(relevancePrompt, 10);

            const subject = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
            console.log(`Email Subject: "${subject}" -> Relevance: ${relevance}`);

            if (relevance.toLowerCase() === 'relevant') {
                const date = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'date')?.value || 'Unknown Date';
                return {
                    id: msg.id,
                    text: `${subject} (from ${new Date(date).toLocaleDateString()})` 
                };
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


async function getEmailDetails(gmail, messageId, userRequest) {
    const neededInfoPrompt = `For a user request like "${userRequest}", what information would an assistant need to complete the task? List them separated by commas.`;
    const neededFields = await callLlamaAPI(neededInfoPrompt);
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId });
    const body = getEmailBody(msg.data.payload);
    const extractionPrompt = `From the email body below, extract the following fields: ${neededFields}. Format the output as a clean list, like "Key: Value". If a piece of information isn't found, state "Not Found".\n\nEmail Body: """${body}"""`;
    return await callLlamaAPI(extractionPrompt, 250);
}

// --- Routes ---
app.get('/auth/status', (req, res) => {
  if (req.session.tokens) res.json({ authenticated: true });
  else res.json({ authenticated: false });
});

app.get('/auth/google', (req, res) => {
  const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (error) {
    console.error('Error getting Google tokens:', error);
    res.send('Error during authentication.');
  }
});

app.post('/search-email', async (req, res) => {
    const { userRequest } = req.body;
    if (!req.session.tokens) return res.status(401).json({ error: 'User is not authenticated.' });

    oauth2Client.setCredentials(req.session.tokens);
    try {
        const vendorPrompt = `From the user request "${userRequest}", what is the primary brand or company name? Respond with only the company name.`;
        const vendor = await callLlamaAPI(vendorPrompt, 20);
        const emailResult = await findInformationInGmail(oauth2Client, vendor, userRequest);
        res.status(200).json(emailResult);
    } catch (error) {
        console.error("Error in /search-email endpoint:", error);
        res.status(500).json({ error: 'Failed to search email.' });
    }
});


app.post('/get-email-details', async (req, res) => {
    const { messageId, userRequest } = req.body;
    if (!req.session.tokens) return res.status(401).json({ error: 'User is not authenticated.' });
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    try {
        const details = await getEmailDetails(gmail, messageId, userRequest);
        res.status(200).json({ context: details });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get email details.' });
    }
});

// UPDATED: This now makes a REAL call to the Vapi API
app.post('/initiate-call', async (req, res) => {
  const { userName, userRequest, phoneNumber, context } = req.body;
  console.log(`Attempting to initiate a REAL Vapi call to ${phoneNumber}...`);

  const baseSystemPrompt = `You are a highly capable, autonomous personal assistant acting as ${userName}. You must act and speak as if you ARE ${userName}, not an assistant calling for them. Do not reveal you are an AI. Be polite and focused.`;
  const systemPrompt = `${baseSystemPrompt}\n\nYour specific task for this call is: "${userRequest}".\n\nYou have the following information from the user's email to help you:\n---${context}\n---`;

  try {
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
        metadata: { userName: userName }
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
    console.log('Call queued successfully with ID:', call.id);
    res.status(200).json({ message: 'Call initiated successfully!', callId: call.id });
  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call.' });
  }
});

// UPDATED: Full webhook logic for real calls
app.post('/call-webhook', (req, res) => {
    const { message } = req.body;
    if (!message || !message.call) return res.status(200).send();

    const callId = message.call.id;
    if (message.type === 'end-of-call-report') {
        callSummaries[callId] = message.summary || "Call ended, but no summary was generated.";
        delete callStatuses[callId];
    } else if (message.type === 'status-update') {
        callStatuses[callId] = `Call status: ${message.status}...`;
    } else if (message.type === 'transcript' && message.transcriptType === 'final') {
        if (message.role === 'assistant') {
            callStatuses[callId] = `Agent is speaking...`;
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
    } else {
        res.status(202).send();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
