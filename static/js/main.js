//--satic/js/main.js--
/* ==========================================================================
   1. GLOBAL CONFIGURATION & STATE
   ========================================================================== */

// Utility to prevent HTML injection and DOM-based XSS attacks
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (match) => {
        const key = {
            //'&': '&amp;',
            //'<': '&lt;',
            //'>': '&gt;',
            //'"': '&quot;',
            //"'": '&#039;'
        };
        return key[match];
    });
}

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
 
// Idle tracking (client-side): update last interaction timestamp
let lastActivityTime = Date.now();
const IDLE_THRESHOLD_MS = 60 * 1000; // 1 minute idle threshold

['mousemove','keydown','scroll','click','touchstart','pointerdown'].forEach(evt => {
    document.addEventListener(evt, () => { lastActivityTime = Date.now(); }, {passive: true});
});
if (typeof marked !== 'undefined') {
    marked.setOptions({
        headerIds: false,
        mangle: false,
        sanitize: false // Allow marked to parse raw quotes into HTML entities correctly
    });
}

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
    channelList: document.getElementById('channel-list'),
    pilotList: document.getElementById('pilot-list'),
    contextMenu: document.getElementById('chat-context-menu'),
    themeToggle: document.getElementById('theme-toggle')
};

// Current active chat channel
let currentChannel = localStorage.getItem('gv_selected_channel') || 'General';

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
            if (AppState.isSearching) {
                UI.gameGrid.innerHTML = "";
                AppState.displayedGames.clear();
            }
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

    // Create the main container for this single message row
    const msgItem = document.createElement('div');
    msgItem.className = 'msg-item';
    if (data.id) {
        msgItem.dataset.msgId = data.id;
    }
    if (data.channel) {
        msgItem.dataset.channel = data.channel;
    }

    // 1. Determine the correct CSS role class (defaults to 'role-crew')
    const userRole = data.role ? data.role.toLowerCase() : 'crew';
    const roleClass = `role-${userRole}`;

    // 2. Format the user header section cleanly and securely
    const cleanUser = escapeHTML(data.user || 'Unknown');
    const displayTime = data.time ? ` [${data.time}]` : '';
    
    // Build the user label using the rank class for custom colors
    const userHeaderHTML = `<span class="${roleClass}" style="font-weight: 700; margin-right: 5px;">${cleanUser}</span><span style="color: var(--text-muted); font-size: 0.75rem;">${displayTime}:</span>`;

    // 3. Process the message content (with Markdown support and @mentions)
    const cleanMsg = escapeHTML(data.msg || '');
    const processedMsg = cleanMsg.replace(/@(\w+)/g, '<span class="mention">@$1</span>');

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'msg-body';
    if (typeof marked !== 'undefined') {
        bodyDiv.innerHTML = marked.parse(processedMsg);
    } else {
        bodyDiv.innerHTML = processedMsg;
    }

    // 4. Combine headers and bodies into the document block
    msgItem.innerHTML = `<div class="msg-header" style="margin-bottom: 2px;">${userHeaderHTML}</div>`;
    msgItem.appendChild(bodyDiv);

    // Append to chat box and auto-scroll down
    UI.chatMsgs.appendChild(msgItem);
    UI.chatMsgs.scrollTop = UI.chatMsgs.scrollHeight;
}

function hideContextMenu() {
    if (!UI.contextMenu) return;
    UI.contextMenu.classList.add('hidden');
}

function showContextMenu(x, y, msgId, channel) {
    if (!UI.contextMenu) return;
    const deleteButton = document.getElementById('delete-message-action');
    if (!deleteButton) return;
    UI.contextMenu.style.left = `${x}px`;
    UI.contextMenu.style.top = `${y}px`;
    UI.contextMenu.classList.remove('hidden');
    deleteButton.dataset.msgId = msgId;
    deleteButton.dataset.channel = channel;
}

function deleteChatMessage(msgId, channel) {
    if (!msgId) return;
    const headers = { 'Content-Type': 'application/json' };
    if (CSRF_TOKEN) headers['X-CSRFToken'] = CSRF_TOKEN;

    fetch('/admin/delete-message', {
        method: 'POST',
        headers,
        body: JSON.stringify({ id: msgId, channel })
    })
    .then(res => res.json())
    .then(data => {
        if (data && data.status === 'success') {
            hideContextMenu();
            showToast({ title: 'Message deleted', content: 'The message was removed for all pilots.' });
        } else {
            showToast({ title: 'Delete failed', content: data.error || 'Unable to delete this message.' });
        }
    })
    .catch(() => {
        showToast({ title: 'Delete failed', content: 'Unable to reach the server.' });
    });
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
                AppState.displayedGames.clear();
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
    // Initialize channel UI if present
    if (UI.channelList) {
        const cards = Array.from(UI.channelList.querySelectorAll('.channel-card'));
        function setActiveCard(name) {
            cards.forEach(c => c.classList.toggle('active', c.querySelector('.channel-name') && c.querySelector('.channel-name').textContent.trim() === name));
        }
        // Attach click handlers
        cards.forEach(card => {
            card.addEventListener('click', (e) => {
                const nameEl = card.querySelector('.channel-name');
                if (!nameEl) return;
                const name = nameEl.textContent.trim();
                if (!name) return;
                joinChannel(name);
            });
        });
        // Apply persisted selection or default
        setActiveCard(currentChannel);
    }

    // Right-click support for admin delete actions
    const adminList = Array.isArray(window.ADMIN_NAME) ? window.ADMIN_NAME : (window.ADMIN_NAME ? [window.ADMIN_NAME] : []);
    const isAdmin = adminList.includes(window.CURRENT_USER);
    if (UI.chatMsgs && isAdmin) {
        UI.chatMsgs.addEventListener('contextmenu', (event) => {
            const msgItem = event.target.closest('.msg-item');
            if (!msgItem || !msgItem.dataset.msgId) return;
            event.preventDefault();
            showContextMenu(event.pageX, event.pageY, msgItem.dataset.msgId, msgItem.dataset.channel);
        });
    }

    document.addEventListener('click', (event) => {
        if (UI.contextMenu && !event.target.closest('#chat-context-menu')) {
            hideContextMenu();
        }
    });

    const deleteAction = document.getElementById('delete-message-action');
    if (deleteAction) {
        deleteAction.addEventListener('click', () => {
            deleteChatMessage(deleteAction.dataset.msgId, deleteAction.dataset.channel);
        });
    }
});

function joinChannel(name) {
    if (!name) return;
    currentChannel = name;
    localStorage.setItem('gv_selected_channel', name);
    
    // Update UI active state safely
    if (UI.channelList) {
        const cards = Array.from(UI.channelList.querySelectorAll('.channel-card'));
        cards.forEach(c => {
            const nameEl = c.querySelector('.channel-name');
            if (nameEl) {
                const channelName = nameEl.textContent.trim();
                c.classList.toggle('active', channelName === name);
            }
        });
    }

    // --- ADMIN PERMISSION CHECK ---
    if (UI.chatInput) {
        const adminList = Array.isArray(window.ADMIN_NAME) ? window.ADMIN_NAME : (window.ADMIN_NAME ? [window.ADMIN_NAME] : []);
        const isAdmin = adminList.includes(window.CURRENT_USER);
        
        if (name.toLowerCase() === 'announcements' && !isAdmin) {
            UI.chatInput.style.display = 'none';
            UI.chatInput.placeholder = "Read-only channel.";
        } else {
            UI.chatInput.style.display = 'block';
            UI.chatInput.placeholder = `Transmit message to ${name}...`;
        }
    }

    if (socket && socket.connected) {
        socket.emit('join_channel', { channel: name });
    }
}

/* ==========================================================================
   7. SOCKET.IO LISTENERS
   ========================================================================== */

    if (socket) {
    // Chat logic
    if (UI.chatMsgs && UI.chatInput) {
        socket.on('message', (data) => {
            // If message carries channel info, ensure it matches current channel
            if (data && data.channel && data.channel !== currentChannel) return;
            addMessage(data);
        });

        socket.on('chat_history', (history) => {
            UI.chatMsgs.innerHTML = '';
            history.forEach(msg => addMessage(msg));
        });

        socket.on('delete_message', (data) => {
            if (!data || !data.id) return;
            const selector = `[data-msg-id="${data.id}"]`;
            const existing = UI.chatMsgs.querySelector(selector);
            if (existing) {
                existing.remove();
            }
        });

        // Locate the chat input listener inside the socket block in main.js
        UI.chatInput.addEventListener('keydown', (e) => {
            // 1. Check if Enter was pressed WITHOUT the Shift key
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Prevent adding a new line on send
                
                const message = UI.chatInput.value.trim();
                if (message) {
                    socket.emit('message', { msg: message, channel: currentChannel });
                    UI.chatInput.value = '';
                    UI.chatInput.style.height = 'auto'; // Reset height after sending
                }
            }
        });

        // 2. Add Auto-Resize Logic (Optional but recommended for textareas)
        UI.chatInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });
    }

    // Pilot List Admin Updates - Now handles Online, Idle, and Offline
    socket.on('admin_user_update', (data) => {
        const statuses = data.user_statuses || {};

        // Update pilot-list card statuses when present (chat view)
        if (UI.pilotList) {
            const cards = Array.from(UI.pilotList.querySelectorAll('.pilot-card'));
            cards.forEach(card => {
                const username = card.getAttribute('data-username');
                const dot = card.querySelector('.status-dot');
                const profileStatus = card.querySelector('.hover-profile-stats .hover-stat span:last-child');
                const currentStatus = statuses[username] || 'offline';

                dot.classList.remove('online', 'offline', 'idle');
                dot.classList.add(currentStatus);

                if (profileStatus) {
                    profileStatus.className = `status-${currentStatus}`;
                    profileStatus.textContent = currentStatus.toUpperCase();
                }
            });

            // Re-sort: Online > Idle > Offline
            const weight = { 'online': 2, 'idle': 1, 'offline': 0 };
            cards.sort((a, b) => {
                const aStat = Array.from(a.querySelector('.status-dot').classList).find(c => weight[c] !== undefined) || 'offline';
                const bStat = Array.from(b.querySelector('.status-dot').classList).find(c => weight[c] !== undefined) || 'offline';
                return weight[bStat] - weight[aStat];
            });
            cards.forEach(card => UI.pilotList.appendChild(card));
        }

        // Update admin dashboard live user list when present (admin view)
        const liveList = document.getElementById('live-user-list');
        if (liveList) {
            liveList.innerHTML = '';
            Object.keys(statuses).forEach(username => {
                const status = statuses[username] || 'offline';
                const li = document.createElement('li');
                li.style.display = 'flex';
                li.style.justifyContent = 'space-between';
                li.style.alignItems = 'center';
                li.style.padding = '8px';
                li.style.borderBottom = '1px solid rgba(255,255,255,0.03)';
                li.innerHTML = `<span style="font-weight:700; color:var(--primary);">${username}</span><span style="text-transform:uppercase; font-size:0.75rem; opacity:0.8;">${status}</span>`;
                liveList.appendChild(li);
            });
        }
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
setInterval(function() {
    fetch('/api/heartbeat')
        .then(response => {
            if (response.status === 401) {
                // If the session actually expired, kick them to login
                window.location.href = '/login';
            }
        })
        .catch(err => console.log('Heartbeat failed:', err));
}, 60000); // 60,000ms = 1 minute


function showToast({ title, content, image }) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';

    // Image Setup
    const imgEl = document.createElement('img');
    imgEl.className = 'toast-img';
    imgEl.src = image || '';
    imgEl.alt = 'Notification Avatar';

    // Body Container
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'toast-body';

    // Title Block
    const titleDiv = document.createElement('div');
    titleDiv.className = 'toast-title';
    titleDiv.textContent = title || '';

    // Message/Content text Block
    const textDiv = document.createElement('div');
    textDiv.className = 'toast-text';
    
    // Safely process mentions in notifications
    const safeContent = escapeHTML(content || '');
    textDiv.innerHTML = safeContent.replace(/@(\w+)/g, '<span class="mention">@$1</span>');

    // Decorative Progress Bar
    const barDiv = document.createElement('div');
    barDiv.className = 'toast-bar';

    // Assemble components securely without dangerous HTML template strings
    bodyDiv.appendChild(titleDiv);
    bodyDiv.appendChild(textDiv);
    toast.appendChild(imgEl);
    toast.appendChild(bodyDiv);
    toast.appendChild(barDiv);
    container.appendChild(toast);

    const autoClose = setTimeout(() => closeToast(toast), 5000);
    toast.onclick = () => {
        clearTimeout(autoClose);
        closeToast(toast);
    };
}

function closeToast(toast) {
    // 1. Add the class that triggers the CSS 'toastSlideOut' animation
    toast.classList.add('outgoing'); 

    // 2. Wait for that specific animation to finish before removing from DOM
    toast.addEventListener('animationend', (e) => {
        // Only remove if the animation that ended was the slide-out
        if (e.animationName === 'toastSlideOut') {
            toast.remove();
        }
    });
}

/* ==========================================================================
   DYNAMIC PILOT HOVER PROFILE POSITIONING
   ========================================================================== */
document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.pilot-card');
    if (!card) return;
    
    const profile = card.querySelector('.pilot-hover-profile');
    if (!profile) return;
    
    // Track where the card sits on the physical screen viewport
    const rect = card.getBoundingClientRect();
    
    // Feed the coordinates instantly to the fixed box
    profile.style.top = `${rect.top + (rect.height / 2)}px`;
    profile.style.left = `${rect.left - 310}px`; // Leaves a sleek 15px margin to the left
});

/* ==========================================================================
   VISIBILITY & IDLE TRACKING (FIXED)
   ========================================================================== */
let wasIdle = false;

function emitStatus() {
    if (!socket || !socket.connected) return;
    
    let currentActivity = "Browsing";
    const path = window.location.pathname;
    
    if (path.startsWith('/play/')) {
        const gameName = path.split('/').pop().replace(/-/g, ' ').toUpperCase();
        currentActivity = `Playing ${gameName}`;
    } else if (path === '/chat') {
        currentActivity = "In Communications";
    } else if (path === '/admin/dashboard') {
        currentActivity = "Reviewing System Logs";
    }

    const now = Date.now();
    const isIdle = (now - lastActivityTime) > IDLE_THRESHOLD_MS;
    const status = isIdle ? 'idle' : 'online';

    wasIdle = isIdle; // Remember state locally

    socket.emit('heartbeat', {
        activity: currentActivity,
        status: status
    });
}

// Reset idle clock AND immediately tell server if we were yellow
['mousemove','keydown','scroll','click','touchstart','pointerdown'].forEach(evt => {
    document.addEventListener(evt, () => { 
        lastActivityTime = Date.now(); 
        if (wasIdle) {
            wasIdle = false;
            emitStatus(); // Instantly tell the server we are back!
        }
    }, {passive: true});
});

// Run every 30 seconds, or instantly on tab focus changes
setInterval(emitStatus, 30000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        lastActivityTime = Date.now(); // Reset time on tab return
    }
    emitStatus();
});

// Consolidated single connect block
if (socket) { 
    socket.on('connect', () => { 
        emitStatus(); 
        if (typeof joinChannel === 'function') joinChannel(currentChannel); 
    }); 
}