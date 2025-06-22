# Timely

Timely is an AI-powered assistant that connects to your Gmail, extracts relevant information from your emails, and helps you automate phone calls to businesses for tasks like returns, appointments, and more. It uses Llama and OpenAI models to analyze your requests and generate structured summaries and call flows.

## Features
- **Gmail Integration:** Securely connect your Gmail to let the assistant search for relevant emails.
- **AI-Powered Extraction:** Uses Llama and OpenAI to extract structured details from emails.
- **Automated Phone Calls:** Initiate calls to businesses with context-aware AI agents.
- **Live Call Status & Summaries:** Get real-time updates and structured summaries after each call.
- **Modern Web UI:** Clean, user-friendly interface for seamless interaction.

## Setup

### 1. Clone the repository
```bash
git clone <your-repo-url>
cd Timely
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
Create a `.env` file or set these variables in your deployment environment:

```
# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
SESSION_SECRET=your_session_secret

# Llama API
LLAMA_API_KEY=your_llama_api_key
LLAMA_API_URL=your_llama_api_url

# OpenAI API
OPENAI_API_KEY=your_openai_api_key

# Vapi (for phone calls)
VAPI_PRIVATE_KEY=your_vapi_private_key
VAPI_PHONE_NUMBER_ID=your_vapi_phone_number_id

# (Optional) Server Port
PORT=3000
```

### 4. Start the server
```bash
node index.js
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Usage
1. **Connect Gmail:** Click the "Connect Gmail" button and complete the OAuth flow.
2. **Describe Your Task:** Enter your name and a request (e.g., "Return my shirt from Banana Republic").
3. **Search Email:** The assistant will find relevant emails and extract details.
4. **Review & Confirm:** Review the extracted information in a table, confirm or edit the phone number, and start the call.
5. **Live Updates:** Watch live call status and receive a structured summary after the call.

## Tech Stack
- Node.js, Express
- Google APIs (Gmail, OAuth2)
- Llama & OpenAI APIs
- Vapi (for phone call automation)
- HTML/CSS/JS (frontend)
