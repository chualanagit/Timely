// FILE 4: public/script.js (Updated)
//================================================================================

const userNameInput = document.getElementById('user-name'); 
const userRequestInput = document.getElementById('user-request');
const phoneNumberInput = document.getElementById('phone-number');
const callButton = document.getElementById('call-button');
const cancelButton = document.getElementById('cancel-button');
const statusDisplay = document.getElementById('status-display');
const summaryBox = document.getElementById('summary-box');

let currentCallId = null;
let pollingInterval = null;

function resetUI() {
    callButton.disabled = false;
    callButton.textContent = '🚀 Create Agent & Start Call';
    cancelButton.classList.add('hidden');
    callButton.classList.remove('hidden');
    statusDisplay.textContent = '';
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

callButton.addEventListener('click', async () => {
  const userName = userNameInput.value; 
  const userRequest = userRequestInput.value;
  const phoneNumber = phoneNumberInput.value;

  if (!userName || !userRequest || !phoneNumber) {
    statusDisplay.textContent = 'Please fill out all fields.';
    return;
  }

  callButton.disabled = true;
  callButton.textContent = 'Initiating...';
  callButton.classList.add('hidden');
  cancelButton.classList.remove('hidden');

  statusDisplay.textContent = 'Sending request to server...';
  summaryBox.textContent = 'Your call summary will appear here after the call is complete...';

  try {
    const response = await fetch('/initiate-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName, userRequest, phoneNumber }),
    });

    const data = await response.json();

    if (response.ok) {
      statusDisplay.textContent = 'Call is in progress!';
      callButton.textContent = 'Call Placed';
      currentCallId = data.callId;
      startPolling(currentCallId);
    } else {
      throw new Error(data.error || 'Failed to start call.');
    }
  } catch (error) {
    statusDisplay.textContent = `Error: ${error.message}`;
    resetUI();
  }
});

cancelButton.addEventListener('click', () => {
    resetUI();
    summaryBox.textContent = 'Call cancelled. Ready for a new task.';
});


function startPolling(callId) {
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }

    pollingInterval = setInterval(async () => {
        if (!currentCallId) return;

        try {
            const statusResponse = await fetch(`/get-status/${callId}`);
            if (statusResponse.status === 200) {
                const statusData = await statusResponse.json();
                if (statusData.status) {
                    statusDisplay.textContent = statusData.status;
                }
            }

            const summaryResponse = await fetch(`/get-summary/${callId}`);
            if (summaryResponse.status === 200) {
                const summaryData = await summaryResponse.json();
                summaryBox.textContent = summaryData.summary;
                statusDisplay.textContent = 'Call finished and summary received!';
                clearInterval(pollingInterval);
                resetUI();
            } else if (summaryResponse.status !== 202) {
                 throw new Error('Failed to fetch summary.');
            }

        } catch (error) {
            console.error('Polling error:', error);
        }
    }, 3000);
}