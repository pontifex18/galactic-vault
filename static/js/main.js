// Read CSRF token injected by server into a meta tag (available globally)
const CSRF_TOKEN = (() => {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : null;
})();

document.addEventListener("DOMContentLoaded", function() {
    const gameGrid = document.getElementById("game-grid");
    const searchInput = document.getElementById("game-search");
    const recentBtn = document.getElementById("nav-recent");
    const favBtn = document.getElementById("nav-favorites");

    let isLoading = false;
    let isSearching = false; 
    const displayedGames = new Set();
    let cachedFavNames = null;


    // --- 1. UTILITY: CLEAR AND ACTIVATE ---
    function setActiveTab(btn) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        btn.classList.add('active');
        if (gameGrid) {
            gameGrid.innerHTML = "";
            displayedGames.clear();
        }
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
        // Ensure favorites are fetched once and cached per view
        const ensureFavs = cachedFavNames ? Promise.resolve(cachedFavNames) : fetch('/api/favorites').then(r => r.json()).then(f => f.map(x => x.name));
        ensureFavs.then(favNames => {
            cachedFavNames = favNames;
            games.forEach(game => {
                if (displayedGames.has(game.name)) return;

                const link = document.createElement("a");
                link.className = "game-link";
                link.setAttribute('href', "/play/" + encodeURIComponent(game.name));
                link.dataset.game = game.name;

                const heart = document.createElement("span");
                heart.className = "fav-heart" + (favNames.includes(game.name) ? " is-favorite" : "");
                heart.textContent = favNames.includes(game.name) ? "❤️" : "🤍";
                heart.onclick = (e) => {
                    e.preventDefault();
                    toggleFav(game.name, heart);
                };

                const thumbBox = document.createElement("div");
                thumbBox.className = "thumb-box";
                if (game.has_thumb) {
                    const img = document.createElement('img');
                    img.src = '/games/' + encodeURIComponent(game.name) + '/thumbnail.png';
                    img.alt = (game.name || 'thumbnail') + ' thumb';
                    thumbBox.appendChild(img);
                } else {
                    thumbBox.textContent = '🎮';
                }

                const title = document.createElement("div");
                title.style.fontSize = "0.75rem";
                title.textContent = game.name.toUpperCase();

                link.append(heart, thumbBox, title);
                gameGrid.appendChild(link);
                displayedGames.add(game.name);
            });
        }).catch(() => {});
    }

    function toggleFav(gameName, heartEl) {
        const headers = { 'Content-Type': 'application/json' };
        if (CSRF_TOKEN) headers['X-CSRFToken'] = CSRF_TOKEN;
        fetch('/api/toggle-favorite', {
            method: 'POST',
            headers,
            body: JSON.stringify({ game: gameName })
        }).then(res => res.json()).then(data => {
            const isFav = data.status === "added";
            heartEl.classList.toggle("is-favorite", isFav);
            heartEl.textContent = isFav ? "❤️" : "🤍";
            
            // If unfavoriting while on the favorites tab, remove the card
            if (isFav) {
                cachedFavNames = cachedFavNames || [];
                if (!cachedFavNames.includes(gameName)) cachedFavNames.push(gameName);
            } else {
                if (cachedFavNames) cachedFavNames = cachedFavNames.filter(n => n !== gameName);
                if (!isFav && favBtn && favBtn.classList.contains("active")) {
                    const card = heartEl.closest('.game-link');
                    if (card) card.remove();
                }
            }
        });
    }

    function loadMoreGames() { if (gameGrid) fetchGames(""); }

    // INITIAL LOAD
    loadMoreGames();
});

let socket = null;
if (typeof io !== 'undefined') {
    socket = io();
}

const chatMsgs = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');

if (chatMsgs && chatInput && socket) {
    function addMessage(data) {
        const div = document.createElement('div');
        div.className = 'msg-item';
        const userDiv = document.createElement('div');
        userDiv.className = 'msg-user';
        userDiv.textContent = `${data.user} [${data.time}]`;
        const msgDiv = document.createElement('div');
        msgDiv.textContent = data.msg;
        div.appendChild(userDiv);
        div.appendChild(msgDiv);
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
}

function toggleChat() {
    const container = document.getElementById('chat-container');
    const arrow = document.getElementById('chat-arrow');
    if (!container || !arrow) return;
    container.classList.toggle('open');
    arrow.textContent = container.classList.contains('open') ? '▼' : '▲';
}

if (socket) {
    socket.on('admin_user_update', (data) => {
    const pilotList = document.getElementById('pilot-list');
    if (!pilotList) return;

    // 1. Get all the pilot cards as an Array
    const cards = Array.from(pilotList.querySelectorAll('.pilot-card'));

    // 2. Update the dots (Green for online, Red for offline)
    cards.forEach(card => {
        const username = card.getAttribute('data-username');
        const dot = card.querySelector('.status-dot');
        
        if (data.users.includes(username)) {
            dot.classList.remove('offline');
            dot.classList.add('online');
        } else {
            dot.classList.remove('online');
            dot.classList.add('offline');
        }
    });

    // 3. SORT: Move online cards to the top
    cards.sort((a, b) => {
        const aOnline = a.querySelector('.status-dot').classList.contains('online');
        const bOnline = b.querySelector('.status-dot').classList.contains('online');
        // Sorts true (1) before false (0)
        return bOnline - aOnline;
    });

    // 4. Re-append to the DOM (this moves them visually)
    cards.forEach(card => pilotList.appendChild(card));
});

}

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
        const headers = { 'Content-Type': 'application/json' };
        if (CSRF_TOKEN) headers['X-CSRFToken'] = CSRF_TOKEN;
        fetch('/api/report-issue', {
            method: 'POST',
            headers,
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

// Handle server-side session denial (another session active)
if (socket) {
    socket.on('session_denied', (data) => {
        try {
            alert((data && data.reason) ? data.reason : 'Session denied: account active elsewhere.');
        } catch (e) {}
        // Redirect to logout to clear client-side session state
        window.location.href = '/logout';
    });

    socket.on('force_logout', (data) => {
        try {
            alert((data && data.reason) ? data.reason : 'You have been logged out due to another session.');
        } catch (e) {}
        window.location.href = '/logout';
    });
}