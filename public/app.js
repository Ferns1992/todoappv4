const API_BASE = '/api';

const state = {
  token: localStorage.getItem('pulseboardToken') || '',
  user: null,
  todos: [],
  users: [],
  editingTodoId: null,
};

const authShell = document.getElementById('authShell');
const appShell = document.getElementById('appShell');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const userList = document.getElementById('userList');
const todoList = document.getElementById('todoList');
const statsGrid = document.getElementById('statsGrid');
const ownerField = document.getElementById('ownerField');
const todoOwner = document.getElementById('todoOwner');
const adminPanel = document.getElementById('adminPanel');
const scopeField = document.getElementById('scopeField');

function setAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.authTab === tab);
  });
  loginForm.classList.toggle('hidden', tab !== 'login');
  registerForm.classList.toggle('hidden', tab !== 'register');
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

function showMessage(message) {
  window.alert(message);
}

function formatDate(dateValue) {
  if (!dateValue) {
    return 'No deadline';
  }
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return dateValue;
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderStats(dashboard) {
  const cards = [
    { label: 'Open tasks', value: dashboard.openCount, tone: 'Open priorities across your board' },
    { label: 'Completed', value: dashboard.completedCount, tone: 'Closed work items delivered' },
    { label: 'High priority', value: dashboard.highPriority, tone: 'Items needing attention first' },
    { label: 'Total tasks', value: dashboard.total, tone: 'Everything in the workspace' },
  ];

  if (state.user.role === 'admin') {
    cards.push(
      { label: 'Team members', value: dashboard.totalUsers, tone: 'All user accounts in the system' },
      { label: 'Admins', value: dashboard.adminCount, tone: 'People with elevated control' }
    );
  }

  statsGrid.innerHTML = cards.map(card => `
    <div class="stat-card">
      <span>${card.label}</span>
      <strong>${card.value}</strong>
      <span>${card.tone}</span>
    </div>
  `).join('');

  document.getElementById('heroOpenCount').textContent = dashboard.openCount;
  document.getElementById('heroDoneCount').textContent = dashboard.completedCount;
  document.getElementById('heroPriorityCount').textContent = dashboard.highPriority;
}

function renderUsers() {
  if (state.user.role !== 'admin') {
    adminPanel.classList.add('hidden');
    ownerField.classList.add('hidden');
    scopeField.classList.add('hidden');
    return;
  }

  adminPanel.classList.remove('hidden');
  ownerField.classList.remove('hidden');
  scopeField.classList.remove('hidden');

  todoOwner.innerHTML = state.users.map(user => `
    <option value="${user.id}" ${user.id === state.user.id ? 'selected' : ''}>
      ${user.username} (${user.role})
    </option>
  `).join('');

  userList.innerHTML = state.users.map(user => `
    <div class="user-card">
      <div class="user-card-meta">
        <strong>${user.username}</strong>
        <p>${user.taskCount} tasks assigned</p>
      </div>
      <select class="role-select" data-user-id="${user.id}" ${user.id === state.user.id ? 'disabled' : ''}>
        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
        <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
      </select>
    </div>
  `).join('');

  userList.querySelectorAll('.role-select').forEach(select => {
    select.addEventListener('change', async event => {
      try {
        await api(`/users/${event.target.dataset.userId}/role`, {
          method: 'PUT',
          body: JSON.stringify({ role: event.target.value }),
        });
        await refreshData();
      } catch (error) {
        showMessage(error.message);
      }
    });
  });
}

function getPriorityLevel(priority) {
  return ['low', 'medium', 'high'].includes(priority) ? priority : 'medium';
}

function renderTodos() {
  if (!state.todos.length) {
    todoList.innerHTML = '<div class="empty-state">No tasks match the current filters yet.</div>';
    return;
  }

  const template = document.getElementById('taskCardTemplate');
  todoList.innerHTML = '';

  state.todos.forEach(todo => {
    const fragment = template.content.cloneNode(true);
    const card = fragment.querySelector('.task-card');
    const title = fragment.querySelector('.task-title');
    const notes = fragment.querySelector('.task-notes');
    const checkbox = fragment.querySelector('.task-check');
    const deleteButton = fragment.querySelector('.task-delete');
    const priorityChip = fragment.querySelector('.chip-priority');
    const categoryChip = fragment.querySelector('.chip-category');
    const dueChip = fragment.querySelector('.chip-due');
    const ownerChip = fragment.querySelector('.chip-owner');

    if (todo.completed) {
      card.classList.add('completed');
    }

    title.textContent = todo.text;
    notes.textContent = todo.notes || 'No extra notes added.';
    checkbox.checked = !!todo.completed;
    priorityChip.textContent = `${todo.priority} priority`;
    priorityChip.dataset.level = getPriorityLevel(todo.priority);
    categoryChip.textContent = todo.category || 'General';
    dueChip.textContent = formatDate(todo.dueDate);
    ownerChip.textContent = `Owner: ${todo.ownerName}`;

    checkbox.addEventListener('change', async event => {
      try {
        await api(`/todos/${todo.id}`, {
          method: 'PUT',
          body: JSON.stringify({ ...todo, completed: event.target.checked }),
        });
        await refreshData();
      } catch (error) {
        showMessage(error.message);
      }
    });

    deleteButton.addEventListener('click', async () => {
      if (!window.confirm(`Delete "${todo.text}"?`)) {
        return;
      }
      try {
        await api(`/todos/${todo.id}`, { method: 'DELETE' });
        await refreshData();
      } catch (error) {
        showMessage(error.message);
      }
    });

    todoList.appendChild(fragment);
  });
}

function renderModeCard() {
  const role = state.user.role;
  document.getElementById('modeTitle').textContent = role === 'admin' ? 'Admin workspace' : 'Regular member';
  document.getElementById('modeDescription').innerHTML = role === 'admin'
    ? 'Admins can create tasks for anyone, view all work items, and change user roles directly from the sidebar.'
    : 'Regular users can create, complete, and remove their own work items with a cleaner dashboard focused on personal execution.';
}

function getTodoPayload() {
  return {
    text: document.getElementById('todoText').value.trim(),
    notes: document.getElementById('todoNotes').value.trim(),
    priority: document.getElementById('todoPriority').value,
    category: document.getElementById('todoCategory').value.trim() || 'General',
    dueDate: document.getElementById('todoDueDate').value,
    ownerId: state.user.role === 'admin' ? Number(todoOwner.value) : state.user.id,
  };
}

function resetTodoForm() {
  document.getElementById('todoForm').reset();
  document.getElementById('saveTaskButton').textContent = 'Create task';
  state.editingTodoId = null;
}

async function refreshData() {
  const dashboard = await api('/dashboard');
  const params = new URLSearchParams();
  const status = document.getElementById('statusFilter').value;
  const priority = document.getElementById('priorityFilter').value;
  const search = document.getElementById('searchFilter').value.trim();
  const scope = document.getElementById('scopeFilter').value;

  if (status && status !== 'all') {
    params.set('status', status);
  }
  if (priority) {
    params.set('priority', priority);
  }
  if (search) {
    params.set('search', search);
  }
  if (state.user.role === 'admin' && scope === 'all') {
    params.set('scope', 'all');
  }

  state.todos = await api(`/todos${params.toString() ? `?${params.toString()}` : ''}`);
  if (state.user.role === 'admin') {
    state.users = await api('/users');
  } else {
    state.users = [];
  }

  renderStats(dashboard);
  renderTodos();
  renderUsers();
  renderModeCard();
}

function renderShell() {
  const isLoggedIn = Boolean(state.user);
  authShell.classList.toggle('hidden', isLoggedIn);
  appShell.classList.toggle('hidden', !isLoggedIn);

  if (!isLoggedIn) {
    return;
  }

  document.getElementById('usernameBadge').textContent = state.user.username;
  document.getElementById('roleBadge').textContent = state.user.role;
  document.getElementById('welcomeLabel').textContent = state.user.role === 'admin'
    ? 'Admin command center'
    : 'Personal productivity board';
  document.getElementById('dashboardTitle').textContent = state.user.role === 'admin'
    ? 'PulseBoard Team Workspace'
    : 'PulseBoard My Work';
}

async function login(username, password) {
  const result = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  state.token = result.token;
  state.user = result.user;
  localStorage.setItem('pulseboardToken', state.token);
  renderShell();
  await refreshData();
}

async function register(username, password) {
  const result = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  state.token = result.token;
  state.user = result.user;
  localStorage.setItem('pulseboardToken', state.token);
  renderShell();
  await refreshData();
}

async function bootstrapSession() {
  if (!state.token) {
    renderShell();
    return;
  }

  try {
    const result = await api('/auth/session');
    state.user = result.user;
    renderShell();
    await refreshData();
  } catch (_error) {
    localStorage.removeItem('pulseboardToken');
    state.token = '';
    state.user = null;
    renderShell();
  }
}

document.querySelectorAll('[data-auth-tab]').forEach(button => {
  button.addEventListener('click', () => setAuthTab(button.dataset.authTab));
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await login(
      document.getElementById('loginUsername').value.trim(),
      document.getElementById('loginPassword').value
    );
  } catch (error) {
    showMessage(error.message);
  }
});

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await register(
      document.getElementById('registerUsername').value.trim(),
      document.getElementById('registerPassword').value
    );
  } catch (error) {
    showMessage(error.message);
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (_error) {
    // Ignore logout failures; clearing local state still unlocks the UI.
  }
  state.token = '';
  state.user = null;
  localStorage.removeItem('pulseboardToken');
  renderShell();
});

document.getElementById('todoForm').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = getTodoPayload();
  if (!payload.text) {
    showMessage('Please enter a task title.');
    return;
  }

  try {
    if (state.editingTodoId) {
      await api(`/todos/${state.editingTodoId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/todos', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    resetTodoForm();
    await refreshData();
  } catch (error) {
    showMessage(error.message);
  }
});

['statusFilter', 'priorityFilter', 'scopeFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', refreshData);
});

document.getElementById('searchFilter').addEventListener('input', () => {
  window.clearTimeout(window.__pulseboardSearchTimer);
  window.__pulseboardSearchTimer = window.setTimeout(refreshData, 220);
});

renderShell();
setAuthTab('login');
bootstrapSession();
