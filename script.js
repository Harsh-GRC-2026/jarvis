const API_URL =
    "https://jarvis.hpgrc204.workers.dev/ask";

const chat = document.getElementById("chat");
const input = document.getElementById("prompt");
const send = document.getElementById("send");

function addMessage(type, text) {

    const message = document.createElement("div");
    message.className = "message " + type;

    const name = document.createElement("div");
    name.className = "name";
    name.textContent =
        type === "user" ? "YOU" : "JARVIS";

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;

    message.appendChild(name);
    message.appendChild(bubble);

    chat.appendChild(message);

    chat.scrollTop = chat.scrollHeight;

    return bubble;
}

async function askJarvis() {

    const prompt = input.value.trim();

    if (!prompt) {
        return;
    }

    input.value = "";

    addMessage("user", prompt);

    send.disabled = true;
    send.textContent = "...";

    const thinking = addMessage(
        "jarvis",
        "Thinking..."
    );

    try {

        const response = await fetch(API_URL, {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                prompt: prompt
            })

        });

        if (!response.ok) {
            throw new Error(
                "Server returned " + response.status
            );
        }

        const data = await response.json();

        thinking.textContent =
            data.response || "No response received.";

    } catch (error) {

        console.error(error);

        thinking.textContent =
            "I could not connect to the JARVIS AI server.";

    }

    send.disabled = false;
    send.textContent = "SEND";

    input.focus();
}

send.addEventListener("click", askJarvis);

input.addEventListener("keydown", function(event) {

    if (event.key === "Enter") {
        askJarvis();
    }

});
