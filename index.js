const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

const callSummaries = {};
const callStatuses = {};

if (!process.env.OPENAI_API_KEY) {
    console.error("WARNING: OPENAI_API_KEY secret not found. The app's AI features will not work without it.");
}

async function deriveOtherPartyRole(userRequest) {
    if (!process.env.OPENAI_API_KEY) return "Contact";

    const roleDerivationPrompt = `
      Based on the following user request, what is the likely job title or role of the person the user wants the AI agent to call? 
      Respond with ONLY the job title and nothing else.
      Examples:
      - Request: "Call Amazon to return my headphones." -> Response: "Customer Service Rep"
      - Request: "Book a haircut for me at SuperCuts." -> Response: "Receptionist"
      User Request: "${userRequest}"
    `;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: [{ role: "system", content: roleDerivationPrompt }],
                temperature: 0.1,
            })
        });
        if (!response.ok) {
           const errorText = await response.text();
           console.error('OpenAI API error during role derivation:', errorText);
           throw new Error('Failed to derive role from OpenAI.');
        }
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch (error) {
        console.error("Error deriving other party role:", error);
        return "Contact";
    }
}

async function generateDetailedSummary(transcript, userName, otherPartyRole) {
    if (!transcript) return "No transcript was available to generate a summary.";
    if (!process.env.OPENAI_API_KEY) return "Could not generate summary: OpenAI API Key is missing.";

    const summaryPrompt = `
      Analyze the following call transcript. The AI agent, acting as "${userName}", called a business. The other party is the "${otherPartyRole}".
      Your task is to provide a concise, easily digestible summary with three distinct sections using Markdown for formatting:
      1.  **Summary:** Write a short, narrative summary of the call.
      2.  **Result:** State the final, definitive outcome of the call.
      3.  **Follow-up Needed:** List any actions that need to be taken. If none, state "None."
      Transcript:
      """
      ${transcript}
      """
    `;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: [{ role: "system", content: summaryPrompt }],
                temperature: 0.3,
            })
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`OpenAI API Error: ${JSON.stringify(errorData)}`);
        }
        const data = await response.json();
        return data.choices[0].message.content;
    } catch (error) {
        console.error("Error generating detailed summary:", error);
        return "Could not generate a detailed summary due to an error.";
    }
}

app.post('/initiate-call', async (req, res) => {
  const { userName, userRequest, phoneNumber } = req.body;
  if (!userName || !userRequest || !phoneNumber) return res.status(400).json({ error: 'All fields are required.' });

  console.log(`Received request to initiate call for ${userName}:`, userRequest);

  try {
    const otherPartyRole = await deriveOtherPartyRole(userRequest);
    console.log(`Derived other party role: ${otherPartyRole}`);

    const replitUrl = `https://${req.get('host')}`;
    const webhookUrl = `${replitUrl}/call-summary-webhook`;

    // UPDATED: Restored the user's detailed system prompt instructions.
    const baseSystemPrompt = `
      You are a highly capable, autonomous personal assistant acting as ${userName}. 
      Your voice and personality should be natural and conversational.
      You must act and speak as if you ARE ${userName}. Use "I" and "my."
      Do not reveal you are an AI or an assistant.

      Your Plan:
      1. If you don't have a piece of information, say you are not sure and will get back to them.
      2. Use the 'sendDTMF' tool to navigate any automated phone menus you encounter. Be precise.
      3. If the other side asks you to repeat information, do it slower than the last time.
      4. If you are providing numerical information, speak slowly and clearly.
      5. Before ending the call, ask the other party to send a confirmation or proof to your email.
      6. If you are stuck in a loop or they keep asking too many questions, politely ask to speak to a human representative.
      7. Once the task is complete, end the call politely.
    `;
    const systemPrompt = `${baseSystemPrompt}\nYour specific task for this call is: "${userRequest}".`;

    const payload = {
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID, 
      customer: { number: phoneNumber },
      assistant: {
        serverUrl: webhookUrl, 
        firstMessage: "Hi there, I'm calling about an issue I need help with.",
        model: { provider: "openai", model: "gpt-3.5-turbo", systemPrompt: systemPrompt },
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
    console.log('Call queued successfully with ID:', call.id);
    res.status(200).json({ message: 'Call initiated successfully!', callId: call.id });

  } catch (error) {
    console.error('Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call.' });
  }
});

app.post('/call-summary-webhook', async (req, res) => {
    const { message } = req.body;
    if (!message || !message.call || !message.call.id) {
        return res.status(200).send();
    }

    const callId = message.call.id;

    switch (message.type) {
        case 'end-of-call-report':
            const transcript = message.transcript || null;
            const userName = message.call.assistant.metadata.userName || 'The User';
            const otherPartyRole = message.call.assistant.metadata.otherPartyRole || 'The Other Party';

            const detailedSummary = await generateDetailedSummary(transcript, userName, otherPartyRole);
            callSummaries[callId] = detailedSummary;

            delete callStatuses[callId];
            break;

        case 'conversation-update':
            const lastMessage = message.conversation[message.conversation.length - 1];
            if (lastMessage.role === 'user') {
                 callStatuses[callId] = `Them: "${lastMessage.content}"`;
            }
            break;

        case 'status-update':
            callStatuses[callId] = `Call status: ${message.status}...`;
            break;

        case 'speech-update':
            if (message.status === 'started' && message.role === 'assistant') {
                callStatuses[callId] = 'Agent is speaking...';
            }
            break;

        default:
            break;
    }

    res.status(200).send();
});

app.get('/get-status/:callId', (req, res) => {
    const { callId } = req.params;
    const status = callStatuses[callId];
    if (status) res.status(200).json({ status });
    else res.status(204).send();
});

app.get('/get-summary/:callId', (req, res) => {
    const { callId } = req.params;
    const summary = callSummaries[callId];

    if (summary) {
        res.status(200).json({ summary });
        delete callSummaries[callId]; 
    } else {
        res.status(202).json({ message: 'Summary not ready yet.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});