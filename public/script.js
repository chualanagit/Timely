// FILE 4: public/script.js (Manual Phone Number & Simplified Flow)
//================================================================================
const googleBtn = document.querySelector('.google-btn');
const agentForm = document.getElementById('agent-form');
const userNameInput = document.getElementById('user-name');
const userRequestInput = document.getElementById('user-request');
const searchButton = document.getElementById('search-button');

const resultsContainer = document.getElementById('results-container');
const emailChoicesDiv = document.getElementById('email-choices');
const extractedContextDiv = document.getElementById('extracted-context');
const finalCallSection = document.getElementById('final-call-section');
const finalPhoneNumberInput = document.getElementById('phone-number-final');
const callButton = document.getElementById('call-button');

const statusDisplay = document.getElementById('status-display');
const summaryBox = document.getElementById('summary-box');

let currentContext = "";

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
    statusDisplay.textContent = 'Searching email...';

    try {
        const response = await fetch('/search-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userRequest }),
        });
        const data = await response.json();
        resultsContainer.classList.remove('hidden');
        statusDisplay.textContent = '';

        if (data.needsSelection) {
            extractedContextDiv.classList.add('hidden');
            emailChoicesDiv.classList.remove('hidden');
            emailChoicesDiv.innerHTML = '<p>Please choose the most relevant email:</p>';
            data.choices.forEach(choice => {
                const button = document.createElement('button');
                button.textContent = choice.text;
                button.onclick = () => handleEmailChoice(choice.id, userRequest);
                emailChoicesDiv.appendChild(button);
            });
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
        searchButton.textContent = '🔍 Search Email for Context';
    }
});

async function handleEmailChoice(messageId, userRequest) {
    emailChoicesDiv.innerHTML = '<p>Extracting details...</p>';
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
        finalCallSection.classList.remove('hidden');
    } catch (error) {
        extractedContextDiv.textContent = "Error getting email details.";
    }
}

callButton.addEventListener('click', async () => {
    const phoneNumber = finalPhoneNumberInput.value;
    if (!phoneNumber) {
        statusDisplay.textContent = "Please enter a phone number to call.";
        return;
    }

    statusDisplay.textContent = `Starting call to ${phoneNumber}...`;
    callButton.disabled = true;

    // Here you would integrate the real call logic
    // For now, it's simulated.
    setTimeout(() => {
        statusDisplay.textContent = "Call simulation finished.";
        summaryBox.textContent = "This is where the real summary would go.";
        resetSearchUI();
    }, 10000);
});


function resetSearchUI() {
    resultsContainer.classList.add('hidden');
    finalCallSection.classList.add('hidden');
    emailChoicesDiv.innerHTML = '';
    extractedContextDiv.textContent = '';
    finalPhoneNumberInput.value = '';
    currentContext = "";
}

document.addEventListener('DOMContentLoaded', checkAuthStatus);