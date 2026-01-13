// Admin Dashboard for EVmessages
class AdminApp {
    constructor() {
        this.apiBase = 'http://localhost:5000/api';
        this.socket = null;
        this.currentUser = null;
        this.currentConversation = null;
        this.token = localStorage.getItem('adminAccessToken');
        this.currentFilter = 'all';
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        this.checkAuthStatus();
    }

    setupEventListeners() {
        // Login form
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
        
        // Message form
        document.getElementById('messageForm').addEventListener('submit', (e) => this.handleSendMessage(e));
        
        // Filter buttons
        document.getElementById('filterAll').addEventListener('click', () => this.filterUsers('all'));
        document.getElementById('filterPending').addEventListener('click', () => this.filterUsers('pending'));
        document.getElementById('filterApproved').addEventListener('click', () => this.filterUsers('approved'));
        document.getElementById('filterRejected').addEventListener('click', () => this.filterUsers('rejected'));
        
        // Logout
        document.getElementById('logoutBtn').addEventListener('click', () => this.logout());
        
        // Message input for typing indicator
        document.getElementById('messageInput').addEventListener('input', () => this.handleTyping());
    }

    showView(viewId) {
        const views = ['loginView', 'dashboardView'];
        views.forEach(view => {
            const element = document.getElementById(view);
            element.classList.toggle('hidden', view !== viewId);
        });
    }

    async checkAuthStatus() {
        if (!this.token) {
            this.showView('loginView');
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
                
                if (data.user.role === 'ADMIN') {
                    this.updateUserDisplay();
                    await this.loadDashboard();
                } else {
                    this.showNotification('Access denied. Admin privileges required.', 'error');
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
                localStorage.setItem('adminAccessToken', this.token);
                
                this.currentUser = data.user;
                
                if (data.user.role === 'ADMIN') {
                    this.updateUserDisplay();
                    await this.loadDashboard();
                } else {
                    this.showNotification('Access denied. Admin privileges required.', 'error');
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
        await Promise.all([
            this.loadUsers(),
            this.loadConversations(),
            this.updateStats()
        ]);
        this.setupSocket();
    }

    async updateStats() {
        try {
            const [usersResponse, conversationsResponse] = await Promise.all([
                fetch(`${this.apiBase}/users`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }),
                fetch(`${this.apiBase}/conversations`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                })
            ]);

            const usersData = await usersResponse.json();
            const conversationsData = await conversationsResponse.json();

            if (usersResponse.ok && conversationsResponse.ok) {
                const users = usersData.users;
                const conversations = conversationsData.conversations;

                // Update stats
                document.getElementById('totalUsers').textContent = users.length;
                document.getElementById('pendingUsers').textContent = users.filter(u => u.status === 'PENDING').length;
                document.getElementById('activeChats').textContent = conversations.filter(c => c.status === 'ACTIVE').length;
                
                // Calculate total unread messages
                const totalUnread = conversations.reduce((sum, conv) => sum + (conv._count?.messages || 0), 0);
                document.getElementById('unreadMessages').textContent = totalUnread;
            }
        } catch (error) {
            console.error('Stats update error:', error);
        }
    }

    async loadUsers() {
        try {
            const response = await fetch(`${this.apiBase}/users`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            const data = await response.json();

            if (response.ok) {
                this.displayUsers(data.users);
            } else {
                console.error('Failed to load users:', data);
            }
        } catch (error) {
            console.error('Users load error:', error);
        }
    }

    displayUsers(users) {
        const container = document.getElementById('usersList');
        container.innerHTML = '';

        const filteredUsers = this.filterUsersByStatus(users, this.currentFilter);

        if (filteredUsers.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500">No users found</p>';
            return;
        }

        filteredUsers.forEach(user => {
            const userEl = this.createUserElement(user);
            container.appendChild(userEl);
        });
    }

    filterUsersByStatus(users, status) {
        if (status === 'all') return users;
        return users.filter(user => user.status.toLowerCase() === status);
    }

    createUserElement(user) {
        const div = document.createElement('div');
        div.className = 'border rounded-lg p-4 hover:bg-gray-50';
        
        const statusColor = {
            'PENDING': 'text-yellow-600 bg-yellow-100',
            'APPROVED': 'text-green-600 bg-green-100',
            'REJECTED': 'text-red-600 bg-red-100',
            'SUSPENDED': 'text-red-600 bg-red-100'
        }[user.status] || 'text-gray-600 bg-gray-100';

        div.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <h4 class="font-medium text-gray-900">${user.name}</h4>
                    <p class="text-sm text-gray-600">${user.email}</p>
                    <p class="text-sm text-gray-500">${user.phone}</p>
                    <div class="mt-2 flex items-center space-x-2">
                        <span class="px-2 py-1 text-xs font-medium rounded-full ${statusColor}">${user.status}</span>
                        <span class="text-xs text-gray-500">Media: ${user.mediaPermission ? 'Granted' : 'Not Granted'}</span>
                    </div>
                </div>
                <div class="flex space-x-2 ml-4">
                    ${user.status === 'PENDING' ? `
                        <button onclick="adminApp.updateUserStatus(${user.id}, 'APPROVED')" class="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">Approve</button>
                        <button onclick="adminApp.updateUserStatus(${user.id}, 'REJECTED')" class="px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700">Reject</button>
                    ` : ''}
                    ${user.status === 'APPROVED' ? `
                        <button onclick="adminApp.updateUserStatus(${user.id}, 'SUSPENDED')" class="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-700">Suspend</button>
                        <button onclick="adminApp.toggleMediaPermission(${user.id})" class="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">
                            ${user.mediaPermission ? 'Revoke Media' : 'Grant Media'}
                        </button>
                    ` : ''}
                    ${user.status === 'SUSPENDED' ? `
                        <button onclick="adminApp.updateUserStatus(${user.id}, 'APPROVED')" class="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700">Unsuspend</button>
                    ` : ''}
                </div>
            </div>
        `;
        
        return div;
    }

    async updateUserStatus(userId, status) {
        try {
            const response = await fetch(`${this.apiBase}/users/${userId}/status`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ status })
            });

            const data = await response.json();

            if (response.ok) {
                this.showNotification(`User ${status.toLowerCase()} successfully`, 'success');
                await this.loadUsers();
                await this.loadConversations();
            } else {
                this.showNotification(data.error || 'Failed to update user status', 'error');
            }
        } catch (error) {
            console.error('Update status error:', error);
            this.showNotification('Failed to update user status', 'error');
        }
    }

    async toggleMediaPermission(userId) {
        try {
            const response = await fetch(`${this.apiBase}/users/${userId}/media-permission`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ granted: true }) // This will toggle based on current state
            });

            const data = await response.json();

            if (response.ok) {
                this.showNotification(data.message, 'success');
                await this.loadUsers();
            } else {
                this.showNotification(data.error || 'Failed to update media permission', 'error');
            }
        } catch (error) {
            console.error('Media permission error:', error);
            this.showNotification('Failed to update media permission', 'error');
        }
    }

    async loadConversations() {
        try {
            const response = await fetch(`${this.apiBase}/conversations`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            const data = await response.json();

            if (response.ok) {
                this.displayConversations(data.conversations);
            } else {
                console.error('Failed to load conversations:', data);
            }
        } catch (error) {
            console.error('Conversations load error:', error);
        }
    }

    displayConversations(conversations) {
        const container = document.getElementById('conversationsList');
        container.innerHTML = '';

        if (conversations.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500">No conversations found</p>';
            return;
        }

        conversations.forEach(conversation => {
            const convEl = this.createConversationElement(conversation);
            container.appendChild(convEl);
        });
    }

    createConversationElement(conversation) {
        const div = document.createElement('div');
        div.className = 'border rounded-lg p-4 hover:bg-gray-50 cursor-pointer';
        div.onclick = () => this.selectConversation(conversation);
        
        const unreadCount = conversation._count?.messages || 0;
        const lastMessage = conversation.messages[0];
        
        div.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <h4 class="font-medium text-gray-900">${conversation.user.name}</h4>
                    <p class="text-sm text-gray-600">${conversation.user.email}</p>
                    ${lastMessage ? `
                        <p class="text-sm text-gray-500 mt-1">${lastMessage.messageText || 'Media message'}</p>
                        <p class="text-xs text-gray-400">${this.formatTime(lastMessage.createdAt)}</p>
                    ` : '<p class="text-sm text-gray-500">No messages yet</p>'}
                </div>
                <div class="text-right">
                    ${unreadCount > 0 ? `
                        <span class="inline-block px-2 py-1 text-xs bg-red-600 text-white rounded-full">${unreadCount} unread</span>
                    ` : ''}
                    <p class="text-xs text-gray-500 mt-1">${conversation.status}</p>
                </div>
            </div>
        `;
        
        return div;
    }

    async selectConversation(conversation) {
        this.currentConversation = conversation;
        document.getElementById('currentChatUser').textContent = `Chatting with ${conversation.user.name}`;
        
        // Load messages
        await this.loadMessages(conversation.id);
        
        // Join conversation room
        if (this.socket) {
            this.socket.emit('join_conversation', { conversationId: conversation.id });
        }
    }

    async loadMessages(conversationId) {
        try {
            const response = await fetch(`${this.apiBase}/conversations/${conversationId}/messages`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            const data = await response.json();

            if (response.ok) {
                this.displayMessages(data.messages);
                this.markMessagesAsRead(conversationId);
            } else {
                console.error('Failed to load messages:', data);
            }
        } catch (error) {
            console.error('Messages load error:', error);
        }
    }

    displayMessages(messages) {
        const container = document.getElementById('messagesContainer');
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500">No messages yet. Start the conversation!</p>';
            return;
        }

        messages.forEach(message => {
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
        bubble.className = `max-w-xs ${isOwn ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-900'} rounded-lg px-3 py-2 text-sm`;
        
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
        
        if (!messageText || !this.currentConversation) return;

        try {
            const response = await fetch(`${this.apiBase}/conversations/${this.currentConversation.id}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messageText,
                    conversationId: this.currentConversation.id
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

    async markMessagesAsRead(conversationId) {
        try {
            await fetch(`${this.apiBase}/conversations/${conversationId}/read`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });
            await this.loadConversations(); // Refresh conversation list to update unread counts
        } catch (error) {
            console.error('Mark read error:', error);
        }
    }

    setupSocket() {
        this.socket = io('http://localhost:5000');
        
        this.socket.on('connect', () => {
            console.log('Admin connected to server');
            this.socket.emit('authenticate', this.token);
        });

        this.socket.on('authenticated', (data) => {
            console.log('Admin socket authenticated:', data);
        });

        this.socket.on('auth_error', (error) => {
            console.error('Admin socket auth error:', error);
        });

        this.socket.on('new_message', (data) => {
            console.log('New message received:', data);
            this.addNewMessage(data.message);
        });

        this.socket.on('typing_start', (data) => {
            if (data.userId !== this.currentUser.id && this.currentConversation) {
                // Could show typing indicator here
            }
        });

        this.socket.on('disconnect', () => {
            console.log('Admin disconnected from server');
        });
    }

    addNewMessage(message) {
        if (!this.currentConversation || message.conversationId !== this.currentConversation.id) return;

        // Add to UI
        const container = document.getElementById('messagesContainer');
        const messageEl = this.createMessageElement(message);
        container.appendChild(messageEl);
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;

        // Mark messages as read
        this.markMessagesAsRead(this.currentConversation.id);
    }

    handleTyping() {
        if (!this.socket || !this.currentConversation) return;

        // Emit typing start
        this.socket.emit('typing_start', { conversationId: this.currentConversation.id });

        // Emit typing stop after 1 second of no typing
        clearTimeout(this.typingTimeout);
        this.typingTimeout = setTimeout(() => {
            this.socket.emit('typing_stop', { conversationId: this.currentConversation.id });
        }, 1000);
    }

    filterUsers(status) {
        this.currentFilter = status;
        
        // Update button styles
        const buttons = {
            'all': 'filterAll',
            'pending': 'filterPending', 
            'approved': 'filterApproved',
            'rejected': 'filterRejected'
        };
        
        Object.values(buttons).forEach(btnId => {
            const btn = document.getElementById(btnId);
            btn.className = 'px-3 py-1 text-sm bg-gray-200 text-gray-700 rounded';
        });
        
        document.getElementById(buttons[status]).className = 'px-3 py-1 text-sm bg-blue-600 text-white rounded';
        
        // Reload users with new filter
        this.loadUsers();
    }

    updateUserDisplay() {
        if (!this.currentUser) return;

        document.getElementById('userStatus').textContent = `${this.currentUser.name} (Admin)`;
        document.getElementById('logoutBtn').classList.remove('hidden');
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
        localStorage.removeItem('adminAccessToken');
        this.token = null;
        this.currentUser = null;
        this.currentConversation = null;
        
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        
        document.getElementById('logoutBtn').classList.add('hidden');
        document.getElementById('userStatus').textContent = '';
        this.showView('loginView');
        
        // Reset form
        document.getElementById('loginForm').reset();
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.adminApp = new AdminApp();
});
