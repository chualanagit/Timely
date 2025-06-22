//================================================================================
// FILE 1: index.js (with Targeted Email Search & Preserved Edits)
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

// --- Google OAuth2 Setup ---
const redirectUri = `https://e6722321-658b-4b05-959d-087e331913bf-00-ezw3nlpl0h7j.picard.replit.dev/auth/google/callback`;
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

// --- Llama API Helper ---
async function callLlamaAPI(prompt, max_tokens = 150) {
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


// --- Gmail Search Logic (Smarter Version) ---
async function findInformationInGmail(authClient, vendor, userRequest) {
    const gmail = google.gmail({ version: 'v1', auth: authClient });

    // Step 1: Determine the type of email to search for.
    const emailTypePrompt = `Based on the user's request, what kind of email should I search for? Respond with a short search query for the subject line. For "return a shirt", respond with 'subject:("order" OR "receipt" OR "return")'. For "cancel my subscription", respond with 'subject:("subscription" OR "cancellation")'. For "book a haircut", respond with 'subject:("appointment" OR "booking")'. User Request: "${userRequest}"`;
    const subjectQuery = await callLlamaAPI(emailTypePrompt, 30);

    const searchQuery = `from:${vendor} ${subjectQuery}`;
    console.log(`Executing targeted Gmail search with query: ${searchQuery}`);

    // Using your updated maxResults value of 50
    const res = await gmail.users.messages.list({ userId: 'me', q: searchQuery, maxResults: 50 }); 
    const messages = res.data.messages;

    if (!messages || messages.length === 0) {
        return { needsSelection: false, context: `I performed a targeted search for "${subjectQuery}" from "${vendor}" but couldn't find any relevant emails.` };
    }

    const emailChoices = [];
    for (const msg of messages.slice(0, 5)) { // Limit to processing the top 5 found for speed
        const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['subject', 'date'] });
        const subject = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
        const date = messageDetails.data.payload.headers.find(h => h.name.toLowerCase() === 'date')?.value || 'Unknown Date';
        emailChoices.push({
            id: msg.id,
            text: `${subject} (from ${new Date(date).toLocaleDateString()})` 
        });
    }

    return { needsSelection: true, choices: emailChoices };
}


async function getEmailDetails(gmail, messageId, userRequest) {
    console.log(`Fetching details for message ID: ${messageId}`);
    const neededInfoPrompt = `For a user request like "${userRequest}", what information (e.g., "Order ID", "Product Name", "Date of Purchase") would an assistant need to complete the task? List them separated by commas.`;
    const neededFields = await callLlamaAPI(neededInfoPrompt);
    console.log(`AI determined these fields are needed: ${neededFields}`);

    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId });
    const body = getEmailBody(msg.data.payload);

    const extractionPrompt = `From the email body below, extract the following fields: ${neededFields}. Format the output as a clean list, like "Key: Value". If a piece of information isn't found, state "Not Found".\n\nEmail Body: """${body}"""`;
    const extractedDetails = await callLlamaAPI(extractionPrompt, 250);
    console.log(`Extracted details from email: \n${extractedDetails}`);
    return extractedDetails;
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
        console.log("Starting email search process...");
        const vendorPrompt = `From the user request "${userRequest}", what is the primary brand or company name? Respond with only the company name.`;
        const vendor = await callLlamaAPI(vendorPrompt, 20);
        console.log(`Derived Vendor: ${vendor}`);

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
    if (!messageId || !userRequest) return res.status(400).json({ error: 'messageId and userRequest are required.' });

    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    try {
        const details = await getEmailDetails(gmail, messageId, userRequest);
        res.status(200).json({ context: details });
    } catch (error) {
        console.error("Error in /get-email-details:", error);
        res.status(500).json({ error: 'Failed to get email details.' });
    }
});

// This is still simulated, you would add the real Vapi call logic here.
app.post('/initiate-call', async (req, res) => {
  console.log("Simulating Vapi call...");
  const callId = `simulated-${Date.now()}`;
  setTimeout(() => {
    callSummaries[callId] = `This is a simulated summary for the call.`;
  }, 10000);
  res.status(200).json({ message: 'Call initiated successfully!', callId: callId });
});

app.get('/get-summary/:callId', (req, res) => {
    const summary = callSummaries[req.params.callId];
    if (summary) res.status(200).json({ summary });
    else res.status(202).send();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
