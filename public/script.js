//================================================================================
// FILE 4: public/script.js (with Status & Summary Restored)
// This version restores the full polling logic for live updates.
//================================================================================

const googleBtn = document.querySelector('.google-btn');
const agentForm = document.getElementById('agent-form');
const userNameInput = document.getElementById('user-name');
const userRequestInput = document.getElementById('user-request');
const searchButton = document.getElementById('search-button');

const resultsContainer = document.getElementById('results-container');
const phoneNumberEntry = document.getElementById('phone-number-entry');
const finalPhoneNumberInput = document.getElementById('phone-number-final'); 

const emailChoicesDiv = document.getElementById('email-choices');
const extractedContextDiv = document.getElementById('extracted-context');
const goBackContainer = document.getElementById('go-back-container');
const callButton = document.getElementById('call-button');
const stopCallButton = document.getElementById('stop-call-button');

const statusDisplay = document.getElementById('status-display');
const callSummaryContainer = document.getElementById('call-summary-container');
const summaryBox = document.getElementById('summary-box');

let currentContext = "";
let currentEmailChoices = [];
let currentCallId = null;
let statusPollingInterval = null;
let summaryPollingInterval = null;

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

searchButton.addEventListener('click', async function handleSearchClick() {
    console.log("Search button clicked.");
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

        statusDisplay.textContent = 'Processing search results...';
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to search email.');
        }

        resultsContainer.classList.remove('hidden');
        statusDisplay.textContent = '';

        phoneNumberEntry.classList.remove('hidden');

        if (data.needsSelection) {
            currentEmailChoices = data.choices;
            displayEmailChoices(data.choices, userRequest);
        } else {
            emailChoicesDiv.innerHTML = `<p>${data.context}</p>`;
            currentContext = data.context;
            callButton.classList.remove('hidden');
        }

    } catch (error) {
        console.error("Search error:", error);
        statusDisplay.textContent = `Error: ${error.message}`;
    } finally {
        console.log("Search process finished, button re-enabled.");
        searchButton.disabled = false;
        searchButton.textContent = '🔍 Search Email for Context';
    }
});

function displayEmailChoices(choices, userRequest) {
    emailChoicesDiv.innerHTML = '<p>I found a few relevant emails. Please choose the correct one:</p>';
    choices.forEach(choice => {
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
        emailChoicesDiv.innerHTML = '';
        extractedContextDiv.innerHTML = `<p>${data.context}</p>`;
        currentContext = data.context;

        if (data.phoneNumberFromEmail) {
            finalPhoneNumberInput.value = data.phoneNumberFromEmail;
        } else {
             finalPhoneNumberInput.placeholder = 'No number in email. Please enter.';
        }

        const goBackButton = document.createElement('button');
        goBackButton.textContent = '← Go Back & Choose Again';
        goBackButton.onclick = () => {
            goBackContainer.innerHTML = '';
            extractedContextDiv.innerHTML = '';
            displayEmailChoices(currentEmailChoices, userRequest);
        };
        goBackContainer.appendChild(goBackButton);

        callButton.classList.remove('hidden');
    } catch (error) {
        extractedContextDiv.innerHTML = "<p>Error getting email details.</p>";
    }
}

callButton.addEventListener('click', async () => {
    const userName = userNameInput.value;
    const userRequest = userRequestInput.value;
    const phoneNumber = finalPhoneNumberInput.value;
    const context = currentContext;

    if (!phoneNumber) {
        statusDisplay.textContent = "Please enter a phone number.";
        return;
    }

    resetCallUI();
    callButton.disabled = true;
    callButton.classList.add('hidden');
    goBackContainer.innerHTML = ''; 
    stopCallButton.classList.remove('hidden');

    try {
        const response = await fetch('/initiate-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userName, userRequest, phoneNumber, context }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to start call.');

        currentCallId = data.callId;
        statusDisplay.textContent = 'Call initiated...';
        callSummaryContainer.classList.remove('hidden');

        statusPollingInterval = setInterval(getStatus, 3000);
        summaryPollingInterval = setInterval(getSummary, 5000);

    } catch (error) {
        statusDisplay.textContent = `Error: ${error.message}`;
        resetCallUI(true);
    }
});

stopCallButton.addEventListener('click', async () => {
    if (!currentCallId) return;
    stopCallButton.disabled = true;
    stopCallButton.textContent = "Stopping...";
    try {
        await fetch('/stop-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId: currentCallId }),
        });
    } catch (error) {
        statusDisplay.textContent = "Error trying to stop the call.";
        stopCallButton.disabled = false;
        stopCallButton.textContent = "🛑 Stop Call";
    }
});


async function getStatus() {
    if (!currentCallId) return;
    try {
        const response = await fetch(`/get-status/${currentCallId}`);
        if (response.status === 200) {
            const data = await response.json();
            if (data.status) {
                statusDisplay.textContent = data.status;
            }
        }
    } catch (error) {
        console.error('Status polling error:', error);
    }
}

async function getSummary() {
    if (!currentCallId) return;
    try {
        const response = await fetch(`/get-summary/${currentCallId}`);
        if (response.status === 200) {
            const data = await response.json();
            summaryBox.innerHTML = data.summary.replace(/\n/g, '<br>'); // Format summary
            resetCallUI(true);
        }
    } catch (error) {
        console.error('Summary polling error:', error);
        resetCallUI(true);
    }
}

function resetSearchUI() {
    resultsContainer.classList.add('hidden');
    callButton.classList.add('hidden');
    emailChoicesDiv.innerHTML = '';
    extractedContextDiv.innerHTML = '';
    goBackContainer.innerHTML = '';
    phoneNumberEntry.classList.add('hidden');
    if(finalPhoneNumberInput) finalPhoneNumberInput.value = '';
    currentContext = "";
    currentEmailChoices = [];
}

function resetCallUI(isCallFinished) {
    if (statusPollingInterval) clearInterval(statusPollingInterval);
    if (summaryPollingInterval) clearInterval(summaryPollingInterval);
    statusPollingInterval = null;
    summaryPollingInterval = null;

    stopCallButton.classList.add('hidden');
    stopCallButton.disabled = false;
    stopCallButton.textContent = "🛑 Stop Call";

    if(isCallFinished) {
        callButton.disabled = false;
        callButton.textContent = "🚀 Confirm & Start Call";
        currentCallId = null;
    }
}

document.addEventListener('DOMContentLoaded', checkAuthStatus);
