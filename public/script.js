const googleBtn = document.querySelector('.google-btn');
const agentForm = document.getElementById('agent-form');
const userNameInput = document.getElementById('user-name');
const userRequestInput = document.getElementById('user-request');
const searchButton = document.getElementById('search-button');

const resultsContainer = document.getElementById('results-container');
const phoneNumberDisplay = document.getElementById('phone-number-display');
const phoneNumberEntry = document.getElementById('phone-number-entry');
const phoneNumberManualInput = document.getElementById('phone-number-manual');
const emailChoicesDiv = document.getElementById('email-choices');
const extractedContextDiv = document.getElementById('extracted-context');
const goBackContainer = document.getElementById('go-back-container');
const finalCallSection = document.getElementById('final-call-section');
const callButton = document.getElementById('call-button');

const statusDisplay = document.getElementById('status-display');
const summaryBox = document.getElementById('summary-box');
const callSummaryContainer = document.getElementById('call-summary-container');

let currentContext = "";
let currentEmailChoices = [];
let pollingInterval = null;

async function checkAuthStatus() {
    try {
        const response = await fetch('/auth/status');
        const data = await response.json();
        if (data.authenticated) {
            googleBtn.classList.add('hidden');
            agentForm.classList.remove('hidden');
            summaryBox.textContent = 'Gmail connected! Please enter your task details.';
        }
    } catch (error) {
        console.error("Error checking auth status:", error);
    }
}

searchButton.addEventListener('click', async () => {
    const userRequest = userRequestInput.value;
    if (!userRequest) {
        statusDisplay.textContent = 'Please enter your request.';
        return;
    }

    resetSearchUI();
    searchButton.disabled = true;
    searchButton.textContent = 'Searching...';
    statusDisplay.textContent = 'Deriving company name...';

    try {
        const response = await fetch('/search-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userRequest }),
        });
        const data = await response.json();
        resultsContainer.classList.remove('hidden');
        statusDisplay.textContent = '';

        if (data.phoneNumber) {
            phoneNumberDisplay.textContent = data.phoneNumber;
            phoneNumberDisplay.classList.remove('hidden');
            phoneNumberEntry.classList.add('hidden');
        } else {
            phoneNumberDisplay.textContent = 'Could not find a phone number. Please enter one.';
            phoneNumberDisplay.classList.remove('hidden');
            phoneNumberEntry.classList.remove('hidden');
        }

        if (data.needsSelection) {
            currentEmailChoices = data.choices;
            displayEmailChoices(userRequest);
        } else {
            emailChoicesDiv.classList.add('hidden');
            extractedContextDiv.classList.remove('hidden');
            extractedContextDiv.textContent = data.context;
            currentContext = data.context;
            finalCallSection.classList.remove('hidden');
        }

    } catch (error) {
        statusDisplay.textContent = `Error: ${error.message}`;
    } finally {
        searchButton.disabled = false;
        searchButton.textContent = '🔍 Search Email & Find Number';
    }
});

function displayEmailChoices(userRequest) {
    extractedContextDiv.classList.add('hidden');
    emailChoicesDiv.classList.remove('hidden');
    finalCallSection.classList.add('hidden');
    emailChoicesDiv.innerHTML = '<p>I found a few relevant emails. Please choose the correct one:</p>';
    currentEmailChoices.forEach(choice => {
        const button = document.createElement('button');
        button.textContent = choice.text;
        button.onclick = () => handleEmailChoice(choice.id, userRequest);
        emailChoicesDiv.appendChild(button);
    });
}

async function handleEmailChoice(messageId, userRequest) {
    emailChoicesDiv.innerHTML = '<p>Extracting details...</p>';
    goBackContainer.innerHTML = ''; 

    try {
        const response = await fetch('/get-email-details', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId, userRequest }),
        });
        const data = await response.json();
        emailChoicesDiv.classList.add('hidden');
        extractedContextDiv.classList.remove('hidden');
        extractedContextDiv.textContent = data.context;
        currentContext = data.context;

        const goBackButton = document.createElement('button');
        goBackButton.textContent = 'Go Back & Choose a Different Email';
        goBackButton.onclick = () => {
            goBackContainer.innerHTML = '';
            displayEmailChoices(userRequest);
        };
        goBackContainer.appendChild(goBackButton);

        finalCallSection.classList.remove('hidden');
    } catch (error) {
        extractedContextDiv.textContent = "Error getting email details.";
    }
}

callButton.addEventListener('click', async () => {
    let phoneNumber = phoneNumberDisplay.textContent;
    if (phoneNumberEntry.classList.contains('hidden') === false) {
        phoneNumber = phoneNumberManualInput.value;
    }

    if (!phoneNumber || !phoneNumber.startsWith('+')) {
        statusDisplay.textContent = "Please enter a valid phone number in E.164 format.";
        return;
    }

    const userName = userNameInput.value;
    const userRequest = userRequestInput.value;

    statusDisplay.textContent = `Initiating call to ${phoneNumber}...`;
    callButton.disabled = true;
    searchButton.disabled = true;

    try {
        const response = await fetch('/initiate-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userName, userRequest, phoneNumber, context: currentContext }),
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to start call.');

        const callId = data.callId;
        callSummaryContainer.classList.remove('hidden');
        summaryBox.textContent = 'Call is in progress...';

        // Start polling for status and summary
        pollingInterval = setInterval(() => pollCallStatus(callId), 3000);

    } catch (error) {
        statusDisplay.textContent = `Error: ${error.message}`;
        callButton.disabled = false;
        searchButton.disabled = false;
    }
});


async function pollCallStatus(callId) {
    try {
        const statusRes = await fetch(`/get-status/${callId}`);
        if (statusRes.ok && statusRes.status !== 204) {
            const statusData = await statusRes.json();
            if(statusData.status) {
                statusDisplay.textContent = statusData.status;
            }
        }

        const summaryRes = await fetch(`/get-summary/${callId}`);
        if (summaryRes.ok && summaryRes.status !== 202) {
            const summaryData = await summaryRes.json();
            summaryBox.textContent = summaryData.summary;
            statusDisplay.textContent = "Call complete!";
            resetUI();
        }

    } catch (error) {
        console.error("Polling error:", error);
        statusDisplay.textContent = "Error fetching updates.";
        resetUI();
    }
}


function resetUI() {
    searchButton.disabled = false;
    callButton.disabled = false;
    resultsContainer.classList.add('hidden');
    callSummaryContainer.classList.add('hidden');
    resetSearchUI();
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

function resetSearchUI() {
    resultsContainer.classList.add('hidden');
    finalCallSection.classList.add('hidden');
    emailChoicesDiv.innerHTML = '';
    extractedContextDiv.textContent = '';
    goBackContainer.innerHTML = '';
    phoneNumberManualInput.value = '';
    currentContext = "";
    currentEmailChoices = [];
}

document.addEventListener('DOMContentLoaded', checkAuthStatus);
