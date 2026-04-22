document.addEventListener("DOMContentLoaded", function() {
    const gameGrid = document.getElementById("game-grid");
    const searchInput = document.getElementById("game-search");
    const recentBtn = document.getElementById("nav-recent");
    const favBtn = document.getElementById("nav-favorites");

    let isLoading = false;
    let isSearching = false; 

    // --- 1. UTILITY: CLEAR AND ACTIVATE ---
    function setActiveTab(btn) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        if (gameGrid) gameGrid.innerHTML = "";
    }

    // --- 2. SEARCH LOGIC ---
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim();
            isSearching = query.length > 0;
            if (isSearching) {
                fetchGames(query);
            } else {
                if (gameGrid) gameGrid.innerHTML = ""; 
                loadMoreGames();
            }
        });
    }

    // --- 3. NAVIGATION LISTENERS ---
    if (recentBtn) {
        recentBtn.addEventListener("click", (e) => {
            e.preventDefault();
            setActiveTab(recentBtn);
            isSearching = true; 
            fetch('/api/recent')
                .then(res => res.json())
                .then(games => {
                    if (games.length === 0) {
                        gameGrid.innerHTML = "<p style='grid-column: 1/-1; text-align: center; opacity: 0.5;'>No history found.</p>";
                    } else {
                        renderGames(games);
                    }
                });
        });
    }

    if (favBtn) {
        favBtn.addEventListener("click", (e) => {
            e.preventDefault();
            setActiveTab(favBtn);
            isSearching = true; 
            fetch('/api/favorites')
                .then(res => res.json())
                .then(games => {
                    if (games.length === 0) {
                        gameGrid.innerHTML = "<p style='grid-column: 1/-1; text-align: center; opacity: 0.5;'>No favorites yet.</p>";
                    } else {
                        renderGames(games);
                    }
                });
        });
    }

    // --- 4. DATA FETCHING & RENDERING ---
    function fetchGames(query = "") {
        if (isLoading || !gameGrid) return;
        isLoading = true;
        fetch(`/api/games?q=${encodeURIComponent(query)}`)
            .then(response => response.json())
            .then(games => {
                if (isSearching) gameGrid.innerHTML = "";
                renderGames(games);
                isLoading = false;
            })
            .catch(() => { isLoading = false; });
    }

    function renderGames(games) {
        if (!gameGrid) return;
        fetch('/api/favorites').then(res => res.json()).then(favs => {
            const favNames = favs.map(f => f.name);
            games.forEach(game => {
                // SAFETY: Don't add if already exists in the current view
                if (gameGrid.querySelector(`[data-game="${game.name}"]`)) return;

                const link = document.createElement("a");
                link.className = "game-link";
                link.href = "/play/" + game.name;
                link.setAttribute('data-game', game.name); 

                const heart = document.createElement("span");
                heart.className = "fav-heart" + (favNames.includes(game.name) ? " is-favorite" : "");
                heart.innerHTML = favNames.includes(game.name) ? "❤️" : "🤍";
                heart.onclick = (e) => { 
                    e.preventDefault(); 
                    toggleFav(game.name, heart); 
                };

                const thumbBox = document.createElement("div");
                thumbBox.className = "thumb-box";
                thumbBox.innerHTML = game.has_thumb ? `<img src="/games/${game.name}/thumbnail.png">` : '🎮';

                const title = document.createElement("div");
                title.style.fontSize = "0.75rem";
                title.textContent = game.name.toUpperCase();

                link.append(heart, thumbBox, title);
                gameGrid.appendChild(link);
            });
        });
    }

    function toggleFav(gameName, heartEl) {
        fetch('/api/toggle-favorite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game: gameName })
        }).then(res => res.json()).then(data => {
            const isFav = data.status === "added";
            heartEl.classList.toggle("is-favorite", isFav);
            heartEl.innerHTML = isFav ? "❤️" : "🤍";
            
            // If unfavoriting while on the favorites tab, remove the card
            if (!isFav && favBtn.classList.contains("active")) {
                heartEl.closest('.game-link').remove();
            }
        });
    }

    function loadMoreGames() { if (gameGrid) fetchGames(""); }

    // INITIAL LOAD
    loadMoreGames();
});

const socket = io();
    const chatMsgs = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');

    function addMessage(data) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        div.innerHTML = `<div class="msg-user">${data.user} [${data.time}]</div><div>${data.msg}</div>`;
        chatMsgs.appendChild(div);
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
    }

    socket.on('message', (data) => addMessage(data));

    socket.on('chat_history', (history) => {
        chatMsgs.innerHTML = '';
        history.forEach(msg => addMessage(msg));
    });

    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && chatInput.value.trim()) {
            socket.emit('message', { msg: chatInput.value });
            chatInput.value = '';
        }
    });
function toggleChat() {
    const container = document.getElementById('chat-container');
    const arrow = document.getElementById('chat-arrow');
    
    // Toggle the 'open' class
    container.classList.toggle('open');
    
    // Change the arrow based on whether the class is present
    if (container.classList.contains('open')) {
        arrow.textContent = '▼'; // Down arrow when open
    } else {
        arrow.textContent = '▲'; // Up arrow when closed
    }
}
// Only run this if we are on the admin page
socket.on('admin_user_update', (data) => {
    const listContainer = document.getElementById('live-user-list');
    if (!listContainer) return; // Exit if not on admin page

    listContainer.innerHTML = ''; // Clear current list

    data.users.forEach(username => {
        const li = document.createElement('li');
        li.style = "padding: 10px; border-bottom: 1px solid var(--border); font-size: 0.8rem;";
        li.innerHTML = `<span style="color: #4ade80;">●</span> ${username} <br><small style="opacity: 0.5;">Status: ACTIVE</small>`;
        listContainer.appendChild(li);
    });

    if (data.users.length === 0) {
        listContainer.innerHTML = '<li style="opacity:0.5; font-size:0.8rem;">No pilots currently online.</li>';
    }
});

const themeToggle = document.getElementById('theme-toggle');
if (localStorage.getItem('vault_theme') === 'light') {
    document.body.classList.add('light-mode');
    if (themeToggle) themeToggle.checked = true;
}

if (themeToggle) {
    themeToggle.addEventListener('change', () => {
        const isLight = themeToggle.checked;
        document.body.classList.toggle('light-mode', isLight);
        localStorage.setItem('vault_theme', isLight ? 'light' : 'dark');
    });
}
// Function to handle the Report Issue prompt
function submitReport(gameName) {
    const report = prompt(`Briefly describe the issue with ${gameName.toUpperCase()}:`);
    if (report && report.trim() !== "") {
        fetch('/api/report-issue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ game: gameName, report: report })
        })
        .then(res => res.json())
        .then(data => {
            if (data.status === "success") {
                alert("Transmission received. Engineers have been notified.");
            }
        })
        .catch(err => alert("Transmission failed. Check connection."));
    }
}

function promoteReport(reportId, gameName, originalReport) {
    const customNote = prompt(`Enter public description for ${gameName}:`, originalReport);
    if (customNote !== null) {
        document.getElementById('p-report-id').value = reportId;
        document.getElementById('p-game-name').value = gameName;
        document.getElementById('p-note').value = customNote;
        document.getElementById('promote-form').submit();
    }
}