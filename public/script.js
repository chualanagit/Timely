const googleBtn = document.querySelector('.google-btn');
const taskChoiceSection = document.getElementById('task-choice-section');
const scheduleBtn = document.getElementById('schedule-btn');
const lookupBtn = document.getElementById('lookup-btn');
const agentForm = document.getElementById('agent-form');
const formHeader = document.getElementById('form-header');
const userNameInput = document.getElementById('user-name');
const userRequestInput = document.getElementById('user-request');
const prepareAgentBtn = document.getElementById('prepare-agent-btn');
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
const callProgressContainer = document.getElementById('call-progress-container');

let currentContext = "";
let currentEmailChoices = [];
let currentCallId = null;
let statusPollingInterval = null;
let summaryPollingInterval = null;
let currentTaskType = '';

async function checkAuthStatus() {
    try {
        const response = await fetch('/auth/status');
        const data = await response.json();
        if (data.authenticated) {
            googleBtn.classList.add('hidden');
            taskChoiceSection.classList.remove('hidden');
        }
    } catch (error) {
        console.error("Error checking auth status:", error);
    }
}

scheduleBtn.addEventListener('click', () => {
    currentTaskType = 'scheduling';
    taskChoiceSection.classList.add('hidden');
    formHeader.textContent = 'Step 2: Describe the Appointment';
    userRequestInput.placeholder = 'e.g., Book a haircut for next Tuesday afternoon.';
    agentForm.classList.remove('hidden');
});

lookupBtn.addEventListener('click', () => {
    currentTaskType = 'lookup';
    taskChoiceSection.classList.add('hidden');
    formHeader.textContent = 'Step 2: Describe Your Request';
    userRequestInput.placeholder = 'e.g., Return my shirt from Banana Republic.';
    agentForm.classList.remove('hidden');
});

prepareAgentBtn.addEventListener('click', async function handlePrepareAgent() {
    const userRequest = userRequestInput.value;
    if (!userRequest) {
        statusDisplay.textContent = 'Please enter your request.';
        return;
    }

    resetSearchUI();
    prepareAgentBtn.disabled = true;
    prepareAgentBtn.textContent = 'Thinking...';

    const endpoint = currentTaskType === 'scheduling' ? '/prepare-scheduling' : '/prepare-lookup';
    statusDisplay.textContent = currentTaskType === 'scheduling' ? 'Checking your calendar...' : 'Searching your email...';

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userRequest }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to prepare agent.');
        }

        resultsContainer.classList.remove('hidden');
        statusDisplay.textContent = '';
        phoneNumberEntry.classList.remove('hidden');

        if (currentTaskType === 'scheduling') {
            extractedContextDiv.innerHTML = `<p><strong>Agent Context:</strong><br>${data.context.replace(/\n/g, '<br>')}</p>`;
            currentContext = data.context;
            callButton.classList.remove('hidden');
        } else { // Lookup path
            if (data.needsSelection) {
                currentEmailChoices = data.choices;
                displayEmailChoices(data.choices, userRequest);
            } else {
                emailChoicesDiv.innerHTML = `<p>${data.context}</p>`;
                currentContext = data.context;
                callButton.classList.remove('hidden');
            }
        }
    } catch (error) {
        console.error("Agent prep error:", error);
        statusDisplay.textContent = `Error: ${error.message}`;
    } finally {
        prepareAgentBtn.disabled = false;
        prepareAgentBtn.textContent = '✅ Prepare Agent';
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

        const table = document.createElement('table');
        table.className = 'details-table';
        const tbody = document.createElement('tbody');
        for (const [key, value] of Object.entries(data.context)) {
            const row = tbody.insertRow();
            row.insertCell().textContent = key;
            row.insertCell().textContent = value;
        }
        table.appendChild(tbody);
        extractedContextDiv.innerHTML = '';
        extractedContextDiv.appendChild(table);

        currentContext = Object.entries(data.context).map(([key, value]) => `${key}: ${value}`).join('\n');
        if (data.phoneNumberFromEmail) finalPhoneNumberInput.value = data.phoneNumberFromEmail;

        const goBackButton = document.createElement('button');
        goBackButton.textContent = '← Go Back';
        goBackButton.onclick = () => {
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
    stopCallButton.classList.remove('hidden');
    callProgressContainer.classList.remove('hidden');

    try {
        const response = await fetch('/initiate-call', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userName, userRequest, phoneNumber, context, taskType: currentTaskType }),
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
            if (data.status) statusDisplay.textContent = data.status;
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
            summaryBox.innerHTML = data.summary.replace(/\n/g, '<br>');
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
    if (finalPhoneNumberInput) finalPhoneNumberInput.value = '';
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

    if (isCallFinished) {
        callButton.disabled = false;
        callButton.textContent = "🚀 Confirm & Start Call";
        currentCallId = null;
    }
}

document.addEventListener('DOMContentLoaded', checkAuthStatus);