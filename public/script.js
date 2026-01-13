// EVmessages Frontend Application
class ChatApp {
    constructor() {
        this.apiBase = 'http://localhost:5000/api';
        this.socket = null;
        this.currentUser = null;
        this.conversation = null;
        this.token = localStorage.getItem('accessToken');
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkAuthStatus();
    }

    setupEventListeners() {
        // Navigation between views
        document.getElementById('showLogin').addEventListener('click', (e) => {
            e.preventDefault();
            this.showView('loginView');
        });

        document.getElementById('showRegister').addEventListener('click', (e) => {
            e.preventDefault();
            this.showView('registerView');
        });

        // Forms
        document.getElementById('registerForm').addEventListener('submit', (e) => this.handleRegister(e));
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('messageForm').addEventListener('submit', (e) => this.handleSendMessage(e));

        // Buttons
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
        document.getElementById('logoutPendingBtn').addEventListener('click', () => this.logout());
        document.getElementById('checkStatusBtn').addEventListener('click', () => this.checkAuthStatus());

        // Message input for typing indicator
        document.getElementById('messageInput').addEventListener('input', () => this.handleTyping());
    }

    showView(viewId) {
        const views = ['registerView', 'loginView', 'dashboardView', 'pendingView'];
        views.forEach(view => {
            const element = document.getElementById(view);
            element.classList.toggle('hidden', view !== viewId);
        });
    }

    async checkAuthStatus() {
        if (!this.token) {
            this.showView('registerView');
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                this.currentUser = data.user;
                this.updateUserDisplay();
                
                if (data.user.status === 'PENDING') {
                    this.showView('pendingView');
                } else if (data.user.status === 'APPROVED') {
                    await this.loadDashboard();
                } else {
                    this.showNotification('Account rejected or suspended. Please contact admin.', 'error');
                    this.logout();
                }
            } else {
                this.logout();
            }
        } catch (error) {
            console.error('Auth check failed:', error);
            this.logout();
        }
    }

    async handleRegister(e) {
        e.preventDefault();
        
        const formData = {
            name: document.getElementById('regName').value,
            email: document.getElementById('regEmail').value,
            phone: document.getElementById('regPhone').value,
            password: document.getElementById('regPassword').value
        };

        try {
            const response = await fetch(`${this.apiBase}/auth/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            const data = await response.json();

            if (response.ok) {
                this.showNotification('Registration successful! Please wait for admin approval.', 'success');
                this.showView('loginView');
                document.getElementById('loginForm').reset();
            } else {
                this.showNotification(data.error || 'Registration failed', 'error');
            }
        } catch (error) {
            console.error('Registration error:', error);
            this.showNotification('Registration failed. Please try again.', 'error');
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        
        const formData = {
            email: document.getElementById('loginEmail').value,
            password: document.getElementById('loginPassword').value
        };

        try {
            const response = await fetch(`${this.apiBase}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formData)
            });

            const data = await response.json();

            if (response.ok) {
                this.token = data.accessToken;
                localStorage.setItem('accessToken', this.token);
                localStorage.setItem('refreshToken', data.refreshToken);
                
                this.currentUser = data.user;
                this.updateUserDisplay();
                
                if (data.user.status === 'PENDING') {
                    this.showView('pendingView');
                } else if (data.user.status === 'APPROVED') {
                    await this.loadDashboard();
                } else {
                    this.showNotification('Account rejected or suspended. Please contact admin.', 'error');
                    this.logout();
                }
            } else {
                this.showNotification(data.error || 'Login failed', 'error');
            }
        } catch (error) {
            console.error('Login error:', error);
            this.showNotification('Login failed. Please try again.', 'error');
        }
    }

    async loadDashboard() {
        this.showView('dashboardView');
        this.updateUserDisplay();
        await this.loadConversation();
        this.setupSocket();
    }

    async loadConversation() {
        try {
            const response = await fetch(`${this.apiBase}/conversations/my-conversation`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            const data = await response.json();

            if (response.ok) {
                this.conversation = data.conversation;
                this.displayMessages();
                this.updateConversationInfo();
            } else {
                console.error('Failed to load conversation:', data);
            }
        } catch (error) {
            console.error('Conversation load error:', error);
        }
    }

    displayMessages() {
        const container = document.getElementById('messagesContainer');
        container.innerHTML = '';

        if (!this.conversation.messages || this.conversation.messages.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500">No messages yet. Start the conversation!</p>';
            return;
        }

        this.conversation.messages.forEach(message => {
            const messageEl = this.createMessageElement(message);
            container.appendChild(messageEl);
        });

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    createMessageElement(message) {
        const div = document.createElement('div');
        const isOwn = message.senderId === this.currentUser.id;
        
        div.className = `flex ${isOwn ? 'justify-end' : 'justify-start'}`;
        
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${isOwn ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} rounded-lg px-4 py-2`;
        
        const content = document.createElement('p');
        content.textContent = message.messageText;
        bubble.appendChild(content);
        
        const timestamp = document.createElement('p');
        timestamp.className = `text-xs mt-1 ${isOwn ? 'text-blue-100' : 'text-gray-500'}`;
        timestamp.textContent = this.formatTime(message.createdAt);
        bubble.appendChild(timestamp);
        
        div.appendChild(bubble);
        return div;
    }

    formatTime(dateString) {
        const date = new Date(dateString);
        return date.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            second: '2-digit',
            hour12: true 
        });
    }

    async handleSendMessage(e) {
        e.preventDefault();
        
        const input = document.getElementById('messageInput');
        const messageText = input.value.trim();
        
        if (!messageText || !this.conversation) return;

        try {
            const response = await fetch(`${this.apiBase}/conversations/${this.conversation.id}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messageText,
                    conversationId: this.conversation.id
                })
            });

            const data = await response.json();

            if (response.ok) {
                input.value = '';
                // Message will be received via socket
            } else {
                this.showNotification(data.error || 'Failed to send message', 'error');
            }
        } catch (error) {
            console.error('Send message error:', error);
            this.showNotification('Failed to send message', 'error');
        }
    }

    setupSocket() {
        this.socket = io('http://localhost:5000');
        
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.socket.emit('authenticate', this.token);
        });

        this.socket.on('authenticated', (data) => {
            console.log('Socket authenticated:', data);
            if (this.conversation) {
                this.socket.emit('join_conversation', { conversationId: this.conversation.id });
            }
        });

        this.socket.on('auth_error', (error) => {
            console.error('Socket auth error:', error);
        });

        this.socket.on('new_message', (data) => {
            console.log('New message received:', data);
            this.addNewMessage(data.message);
        });

        this.socket.on('typing_start', (data) => {
            if (data.userId !== this.currentUser.id) {
                document.getElementById('typingIndicator').classList.remove('hidden');
            }
        });

        this.socket.on('typing_stop', (data) => {
            if (data.userId !== this.currentUser.id) {
                document.getElementById('typingIndicator').classList.add('hidden');
            }
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
        });
    }

    addNewMessage(message) {
        if (!this.conversation) return;

        // Add to conversation data
        if (!this.conversation.messages) {
            this.conversation.messages = [];
        }
        this.conversation.messages.push(message);

        // Add to UI
        const container = document.getElementById('messagesContainer');
        const messageEl = this.createMessageElement(message);
        container.appendChild(messageEl);
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;

        // Mark messages as read
        this.markMessagesAsRead();
    }

    async markMessagesAsRead() {
        if (!this.conversation) return;

        try {
            await fetch(`${this.apiBase}/conversations/${this.conversation.id}/read`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
        } catch (error) {
            console.error('Mark read error:', error);
        }
    }

    handleTyping() {
        if (!this.socket || !this.conversation) return;

        // Emit typing start
        this.socket.emit('typing_start', { conversationId: this.conversation.id });

        // Emit typing stop after 1 second of no typing
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            this.socket.emit('typing_stop', { conversationId: this.conversation.id });
        }, 1000);
    }

    updateUserDisplay() {
        if (!this.currentUser) return;

        // Update navigation
        document.getElementById('userStatus').textContent = `${this.currentUser.name} (${this.currentUser.status})`;
        document.getElementById('logoutBtn').classList.remove('hidden');

        // Update dashboard info
        document.getElementById('userName').textContent = this.currentUser.name;
        document.getElementById('userEmail').textContent = this.currentUser.email;
        document.getElementById('accountStatus').textContent = this.currentUser.status;
        document.getElementById('mediaPermission').textContent = this.currentUser.mediaPermission ? 'Granted' : 'Not Granted';

        // Update status badges
        const statusEl = document.getElementById('accountStatus');
        const mediaEl = document.getElementById('mediaPermission');
        
        // Status badge styling
        statusEl.className = 'badge';
        switch(this.currentUser.status) {
            case 'APPROVED':
                statusEl.classList.add('badge-success');
                break;
            case 'PENDING':
                statusEl.classList.add('badge-warning');
                break;
            case 'REJECTED':
                statusEl.classList.add('badge-error');
                break;
            case 'SUSPENDED':
                statusEl.classList.add('badge-error');
                break;
        }

        // Media permission badge styling
        mediaEl.className = 'badge';
        if (this.currentUser.mediaPermission) {
            mediaEl.classList.add('badge-success');
        } else {
            mediaEl.classList.add('badge-secondary');
        }
    }

    updateConversationInfo() {
        const infoEl = document.getElementById('conversationInfo');
        if (!this.conversation) {
            infoEl.innerHTML = '<p class="text-gray-500">No conversation found</p>';
            return;
        }

        const messageCount = this.conversation.messages ? this.conversation.messages.length : 0;
        const lastMessage = this.conversation.lastMessageAt ? 
            new Date(this.conversation.lastMessageAt).toLocaleString() : 'No messages yet';

        infoEl.innerHTML = `
            <div class="space-y-2">
                <p><strong>Conversation ID:</strong> ${this.conversation.id}</p>
                <p><strong>Status:</strong> ${this.conversation.status}</p>
                <p><strong>Messages:</strong> ${messageCount}</p>
                <p><strong>Last Activity:</strong> ${lastMessage}</p>
                <p><strong>Started:</strong> ${new Date(this.conversation.createdAt).toLocaleString()}</p>
            </div>
        `;
    }

    showNotification(message, type = 'info') {
        const container = document.getElementById('notificationContainer');
        const notification = document.createElement('div');
        
        const icon = type === 'success' ? 'fa-check-circle' : 
                     type === 'error' ? 'fa-exclamation-circle' : 
                     'fa-info-circle';
        
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-icon">
                <i class="fas ${icon}"></i>
            </div>
            <div class="flex-1">
                <p class="font-medium">${message}</p>
            </div>
            <button class="ml-4 text-gray-400 hover:text-gray-600 transition-colors" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        container.appendChild(notification);
        
        // Auto remove after 5 seconds
        setTimeout(() => {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }

    logout() {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        this.token = null;
        this.currentUser = null;
        this.conversation = null;
        
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        
        document.getElementById('logoutBtn').classList.add('hidden');
        document.getElementById('userStatus').textContent = '';
        this.showView('registerView');
        
        // Reset forms
        document.getElementById('registerForm').reset();
        document.getElementById('loginForm').reset();
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ChatApp();
});
