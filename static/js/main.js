/* ==========================================================================
   1. GLOBAL CONFIGURATION & STATE
   ========================================================================== */

// Read CSRF token injected by server into a meta tag
const CSRF_TOKEN = (() => {
    const m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.getAttribute('content') : null;
})();

// Global state container for the application
const AppState = {
    isLoading: false,
    isSearching: false,
    displayedGames: new Set(),
    cachedFavNames: null
};

// Global Socket reference
let socket = (typeof io !== 'undefined') ? io() : null;

/* ==========================================================================
   2. DOM SELECTOR CACHE
   ========================================================================== */

const UI = {
    gameGrid: document.getElementById("game-grid"),
    searchInput: document.getElementById("game-search"),
    recentBtn: document.getElementById("nav-recent"),
    favBtn: document.getElementById("nav-favorites"),
    chatMsgs: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatContainer: document.getElementById('chat-container'),
    chatArrow: document.getElementById('chat-arrow'),
    pilotList: document.getElementById('pilot-list'),
    themeToggle: document.getElementById('theme-toggle')
};

/* ==========================================================================
   3. CORE UI LOGIC
   ========================================================================== */

function setActiveTab(btn) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    if (UI.gameGrid) {
        UI.gameGrid.innerHTML = "";
        AppState.displayedGames.clear();
    }
}

function renderGames(games) {
    if (!UI.gameGrid) return;

    // Ensure favorites are fetched once and cached per view
    const ensureFavs = AppState.cachedFavNames 
        ? Promise.resolve(AppState.cachedFavNames) 
        : fetch('/api/favorites').then(r => r.json()).then(f => f.map(x => x.name));

    ensureFavs.then(favNames => {
        AppState.cachedFavNames = favNames;
        
        games.forEach(game => {
            if (AppState.displayedGames.has(game.name)) return;

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
            UI.gameGrid.appendChild(link);
            AppState.displayedGames.add(game.name);
        });
    }).catch(() => {});
}

/* ==========================================================================
   4. API & DATA FETCHING
   ========================================================================== */

function fetchGames(query = "") {
    if (AppState.isLoading || !UI.gameGrid) return;
    AppState.isLoading = true;
    
    fetch(`/api/games?q=${encodeURIComponent(query)}`)
        .then(response => response.json())
        .then(games => {
            if (AppState.isSearching) UI.gameGrid.innerHTML = "";
            renderGames(games);
            AppState.isLoading = false;
        })
        .catch(() => { AppState.isLoading = false; });
}

function toggleFav(gameName, heartEl) {
    const headers = { 'Content-Type': 'application/json' };
    if (CSRF_TOKEN) headers['X-CSRFToken'] = CSRF_TOKEN;

    fetch('/api/toggle-favorite', {
        method: 'POST',
        headers,
        body: JSON.stringify({ game: gameName })
    })
    .then(res => res.json())
    .then(data => {
        const isFav = data.status === "added";
        heartEl.classList.toggle("is-favorite", isFav);
        heartEl.textContent = isFav ? "❤️" : "🤍";
        
        if (isFav) {
            AppState.cachedFavNames = AppState.cachedFavNames || [];
            if (!AppState.cachedFavNames.includes(gameName)) AppState.cachedFavNames.push(gameName);
        } else {
            if (AppState.cachedFavNames) AppState.cachedFavNames = AppState.cachedFavNames.filter(n => n !== gameName);
            if (!isFav && UI.favBtn && UI.favBtn.classList.contains("active")) {
                const card = heartEl.closest('.game-link');
                if (card) card.remove();
            }
        }
    });
}

function loadMoreGames() { 
    if (UI.gameGrid) fetchGames(""); 
}

/* ==========================================================================
   5. FEATURE MODULES (Chat, Theme, Reporting)
   ========================================================================== */

// Chat Functionality
function addMessage(data) {
    if (!UI.chatMsgs) return;
    const div = document.createElement('div');
    div.className = 'msg-item';
    
    const userDiv = document.createElement('div');
    userDiv.className = 'msg-user';
    userDiv.textContent = `${data.user} [${data.time}]`;
    
    const msgDiv = document.createElement('div');
    msgDiv.textContent = data.msg;
    
    div.appendChild(userDiv);
    div.appendChild(msgDiv);
    UI.chatMsgs.appendChild(div);
    UI.chatMsgs.scrollTop = UI.chatMsgs.scrollHeight;
}

function toggleChat() {
    if (!UI.chatContainer || !UI.chatArrow) return;
    UI.chatContainer.classList.toggle('open');
    UI.chatArrow.textContent = UI.chatContainer.classList.contains('open') ? '▼' : '▲';
}

// Issue Reporting
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
            if (data.status === "success") alert("Transmission received. Engineers have been notified.");
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

/* ==========================================================================
   6. EVENT INITIALIZATION
   ========================================================================== */

document.addEventListener("DOMContentLoaded", function() {
    
    // --- Search Input ---
    if (UI.searchInput) {
        UI.searchInput.addEventListener("input", (e) => {
            const query = e.target.value.trim();
            AppState.isSearching = query.length > 0;
            if (AppState.isSearching) {
                fetchGames(query);
            } else {
                if (UI.gameGrid) UI.gameGrid.innerHTML = ""; 
                loadMoreGames();
            }
        });
    }

    // --- Recent Tab ---
    if (UI.recentBtn) {
        UI.recentBtn.addEventListener("click", (e) => {
            e.preventDefault();
            setActiveTab(UI.recentBtn);
            AppState.isSearching = true; 
            fetch('/api/recent')
                .then(res => res.json())
                .then(games => {
                    if (games.length === 0) {
                        UI.gameGrid.innerHTML = "<p style='grid-column: 1/-1; text-align: center; opacity: 0.5;'>No history found.</p>";
                    } else {
                        renderGames(games);
                    }
                });
        });
    }

    // --- Favorites Tab ---
    if (UI.favBtn) {
        UI.favBtn.addEventListener("click", (e) => {
            e.preventDefault();
            setActiveTab(UI.favBtn);
            AppState.isSearching = true; 
            fetch('/api/favorites')
                .then(res => res.json())
                .then(games => {
                    if (games.length === 0) {
                        UI.gameGrid.innerHTML = "<p style='grid-column: 1/-1; text-align: center; opacity: 0.5;'>No favorites yet.</p>";
                    } else {
                        renderGames(games);
                    }
                });
        });
    }

    // --- Theme Management ---
    if (localStorage.getItem('vault_theme') === 'light') {
        document.body.classList.add('light-mode');
        if (UI.themeToggle) UI.themeToggle.checked = true;
    }

    if (UI.themeToggle) {
        UI.themeToggle.addEventListener('change', () => {
            const isLight = UI.themeToggle.checked;
            document.body.classList.toggle('light-mode', isLight);
            localStorage.setItem('vault_theme', isLight ? 'light' : 'dark');
        });
    }

    // Initial Data Load
    loadMoreGames();
});

/* ==========================================================================
   7. SOCKET.IO LISTENERS
   ========================================================================== */

if (socket) {
    // Chat logic
    if (UI.chatMsgs && UI.chatInput) {
        socket.on('message', (data) => addMessage(data));

        socket.on('chat_history', (history) => {
            UI.chatMsgs.innerHTML = '';
            history.forEach(msg => addMessage(msg));
        });

        UI.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && UI.chatInput.value.trim()) {
                socket.emit('message', { msg: UI.chatInput.value });
                UI.chatInput.value = '';
            }
        });
    }

    // Pilot List Admin Updates
    socket.on('admin_user_update', (data) => {
        if (!UI.pilotList) return;
        const cards = Array.from(UI.pilotList.querySelectorAll('.pilot-card'));

        cards.forEach(card => {
            const username = card.getAttribute('data-username');
            const dot = card.querySelector('.status-dot');
            const isOnline = data.users.includes(username);
            
            dot.classList.toggle('online', isOnline);
            dot.classList.toggle('offline', !isOnline);
        });

        // SORT: Move online cards to the top
        cards.sort((a, b) => {
            const aOnline = a.querySelector('.status-dot').classList.contains('online');
            const bOnline = b.querySelector('.status-dot').classList.contains('online');
            return bOnline - aOnline;
        });

        cards.forEach(card => UI.pilotList.appendChild(card));
    });

    // Session Management
    socket.on('session_denied', (data) => {
        try {
            alert((data && data.reason) ? data.reason : 'Session denied: account active elsewhere.');
        } catch (e) {}
        window.location.href = '/logout';
    });

    socket.on('force_logout', (data) => {
        try {
            alert((data && data.reason) ? data.reason : 'You have been logged out due to another session.');
        } catch (e) {}
        window.location.href = '/logout';
    });
}