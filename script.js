const API_BASE = 'http://127.0.0.1:8080';

let currentUser = null;
let roommatesData = [];
let expensesData = [];
let pollInterval = null;

// Initialize on page load
window.addEventListener('DOMContentLoaded', async () => {
  initParticleCanvas();
  await fetchRoommates();
  renderSlotsGrid();
});

// ------------------------------------------------------------- 1. CANVAS PARTICLES ANIMATION
function initParticleCanvas() {
  const canvas = document.getElementById('particleCanvas');
  const ctx = canvas.getContext('2d');
  let width, height;
  let particles = [];

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  let mouse = { x: -1000, y: -1000 };
  window.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });
  window.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      mouse.x = e.touches[0].clientX;
      mouse.y = e.touches[0].clientY;
    }
  });

  class Particle {
    constructor() {
      this.reset();
    }
    reset() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.size = Math.random() * 2 + 0.8;
      this.speedX = (Math.random() - 0.5) * 0.6;
      this.speedY = (Math.random() - 0.5) * 0.6 - 0.2;
      this.alpha = Math.random() * 0.5 + 0.2;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;

      // React gently to mouse/touch
      let dx = mouse.x - this.x;
      let dy = mouse.y - this.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 100) {
        let angle = Math.atan2(dy, dx);
        this.x -= Math.cos(angle) * 1.5;
        this.y -= Math.sin(angle) * 1.5;
      }

      if (this.x < 0 || this.x > width || this.y < 0 || this.y > height) {
        this.reset();
      }
    }
    draw() {
      ctx.fillStyle = `rgba(56, 189, 248, ${this.alpha})`;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (let i = 0; i < 50; i++) {
    particles.push(new Particle());
  }

  function animate() {
    ctx.clearRect(0, 0, width, height);
    particles.forEach(p => {
      p.update();
      p.draw();
    });
    requestAnimationFrame(animate);
  }
  animate();
}

// ------------------------------------------------------------- 2. API HELPERS
async function apiFetch(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Server error');
    return data;
  } catch (err) {
    throw err;
  }
}

async function fetchRoommates() {
  const res = await apiFetch('/api/roommates');
  roommatesData = res.roommates;
}

// ------------------------------------------------------------- 3. SLOTS GRID & AUTH MORPH
function renderSlotsGrid() {
  const grid = document.getElementById('slotsGrid');
  grid.innerHTML = roommatesData.map(s => {
    const isRegistered = s.registered;
    return `
      <div class="slot-card ${isRegistered ? 'registered' : ''}" onclick="selectSlot(${s.id})">
        <div class="slot-avatar" style="background: ${getAvatarGradient(s.id)}">
          ${s.name ? s.name.charAt(0).toUpperCase() : s.id}
        </div>
        <div class="slot-name">${s.name || `Student ${s.id}`}</div>
        <span class="slot-status ${isRegistered ? 'status-login' : 'status-open'}">
          ${isRegistered ? 'Login' : 'Open'}
        </span>
      </div>
    `;
  }).join('');
}

function getAvatarGradient(id) {
  const gradients = [
    'linear-gradient(135deg, #3b82f6, #1d4ed8)',
    'linear-gradient(135deg, #10b981, #047857)',
    'linear-gradient(135deg, #8b5cf6, #6d28d9)',
    'linear-gradient(135deg, #f59e0b, #d97706)',
    'linear-gradient(135deg, #ec4899, #be185d)',
    'linear-gradient(135deg, #06b6d4, #0e7490)'
  ];
  return gradients[id % gradients.length];
}

function selectSlot(sid) {
  if (navigator.vibrate) navigator.vibrate(30); // Haptic feedback

  const student = roommatesData.find(s => s.id === sid);
  document.getElementById('slotSelectionView').classList.add('hidden');
  const modalPanel = document.getElementById('pinModalPanel');
  modalPanel.classList.remove('hidden');

  document.getElementById('selectedSlotBadge').innerText = `Slot ${sid}: ${student.name || 'Unregistered'}`;
  document.getElementById('authError').innerText = '';
  const formArea = document.getElementById('authFormArea');

  if (!student.registered) {
    formArea.innerHTML = `
      <div class="form-group">
        <label>Your Display Name</label>
        <input type="text" id="authName" placeholder="Enter your name" required />
      </div>
      <div class="form-group">
        <label>Create 4-Digit PIN</label>
        <input type="password" id="authPin" maxlength="4" placeholder="1234" required />
      </div>
      <div class="form-group">
        <label>Master Admin Key</label>
        <input type="password" id="authMasterKey" value="1234" required />
      </div>
      <button class="btn btn-primary" onclick="submitRegister(${student.id})">Register Slot</button>
    `;
  } else {
    formArea.innerHTML = `
      <div class="form-group">
        <label>Enter 4-Digit PIN for ${student.name}</label>
        <input type="password" id="authPin" maxlength="4" placeholder="****" autofocus required />
      </div>
      <button class="btn btn-primary" onclick="submitLogin(${student.id})">Login to Room 7</button>
    `;
  }
}

function backToSlots() {
  if (navigator.vibrate) navigator.vibrate(20);
  document.getElementById('pinModalPanel').classList.add('hidden');
  document.getElementById('slotSelectionView').classList.remove('hidden');
  fetchRoommates().then(renderSlotsGrid);
}

async function submitLogin(sid) {
  const pinInput = document.getElementById('authPin');
  const pin = pinInput.value;
  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ student_id: sid, pin }),
    });
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]); // Success haptic
    loginSuccess(res.user);
  } catch (err) {
    if (navigator.vibrate) navigator.vibrate(80); // Error haptic
    const card = document.getElementById('pinModalPanel');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 400);
    document.getElementById('authError').innerText = err.message;
  }
}

async function submitRegister(sid) {
  const name = document.getElementById('authName').value;
  const pin = document.getElementById('authPin').value;
  const masterKey = document.getElementById('authMasterKey').value;

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ student_id: sid, name, pin, master_key: masterKey }),
    });
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    await fetchRoommates();
    loginSuccess(res.user);
  } catch (err) {
    if (navigator.vibrate) navigator.vibrate(80);
    const card = document.getElementById('pinModalPanel');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 400);
    document.getElementById('authError').innerText = err.message;
  }
}

function loginSuccess(user) {
  currentUser = user;
  document.getElementById('authSection').classList.add('hidden');
  document.getElementById('appSection').classList.remove('hidden');

  document.getElementById('navName').innerText = user.name;
  document.getElementById('navAvatar').innerText = user.name.charAt(0).toUpperCase();

  loadSavedAvatar();

  const splitContainer = document.getElementById('splitCheckboxes');
  if (splitContainer) {
    splitContainer.innerHTML = roommatesData.map(s => `
      <label class="chip-label" style="display:flex; align-items:center; gap:8px; background:rgba(30,41,59,0.8); padding:6px 10px; border-radius:8px; cursor:pointer;">
        <input type="checkbox" value="${s.id}" checked style="accent-color: var(--accent-cyan); width:16px; height:16px;" /> ${s.name}
      </label>
    `).join('');
  }

  refreshAppData();
  pollInterval = setInterval(refreshAppData, 3000);
}

function logout() {
  currentUser = null;
  clearInterval(pollInterval);
  document.getElementById('appSection').classList.add('hidden');
  document.getElementById('authSection').classList.remove('hidden');
  document.getElementById('pinModalPanel').classList.add('hidden');
  document.getElementById('slotSelectionView').classList.remove('hidden');
  fetchRoommates().then(renderSlotsGrid);
}

// ------------------------------------------------------------- 4. PROFILE & AVATAR LOGIC
function openProfileModal() {
  if (!currentUser) return;
  document.getElementById('modalStudentName').innerText = currentUser.name;
  document.getElementById('modalStudentSlot').innerText = currentUser.id;
  document.getElementById('privateSlot').innerText = `Slot ${currentUser.id}`;
  
  const savedPic = localStorage.getItem(`avatar_slot_${currentUser.id}`);
  if (savedPic) {
    document.getElementById('modalAvatarImg').src = savedPic;
    document.getElementById('modalAvatarImg').classList.remove('hidden');
    document.getElementById('modalAvatarText').classList.add('hidden');
  } else {
    document.getElementById('modalAvatarText').innerText = currentUser.name.charAt(0).toUpperCase();
    document.getElementById('modalAvatarText').classList.remove('hidden');
    document.getElementById('modalAvatarImg').classList.add('hidden');
  }

  document.getElementById('profileModal').classList.remove('hidden');
}

function closeProfileModal() {
  document.getElementById('profileModal').classList.add('hidden');
}

function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const base64Img = e.target.result;
    localStorage.setItem(`avatar_slot_${currentUser.id}`, base64Img);
    loadSavedAvatar();
    openProfileModal();
    renderRoommatesProfiles();
  };
  reader.readAsDataURL(file);
}

function loadSavedAvatar() {
  if (!currentUser) return;
  const savedPic = localStorage.getItem(`avatar_slot_${currentUser.id}`);
  const navImg = document.getElementById('navAvatarImg');
  const navText = document.getElementById('navAvatar');

  if (savedPic) {
    navImg.src = savedPic;
    navImg.classList.remove('hidden');
    navText.classList.add('hidden');
  } else {
    navText.classList.remove('hidden');
    navImg.classList.add('hidden');
  }
}

// ------------------------------------------------------------- 5. APP DATA SYNC & RENDERING
async function refreshAppData() {
  await Promise.all([
    renderDashboardAndExpenses(),
    renderRoommatesProfiles(),
    renderCartView(),
    renderReceiptsView()
  ]);
}

async function renderDashboardAndExpenses() {
  const [expRes, setRes] = await Promise.all([
    apiFetch('/api/expenses'),
    apiFetch('/api/settle')
  ]);
  
  expensesData = expRes.expenses;

  let totalSpending = expensesData.reduce((sum, e) => sum + Number(e.amount), 0);
  document.getElementById('statTotalSpending').innerText = `₦${totalSpending.toLocaleString(undefined, {minimumFractionDigits: 2})}`;

  const myBalance = setRes.balances_by_id[String(currentUser.id)] || 0;
  if (myBalance >= 0) {
    document.getElementById('statYouAreOwed').innerText = `₦${myBalance.toLocaleString(undefined, {minimumFractionDigits: 2})}`;
    document.getElementById('statYouOwe').innerText = `₦0.00`;
  } else {
    document.getElementById('statYouAreOwed').innerText = `₦0.00`;
    document.getElementById('statYouOwe').innerText = `₦${Math.abs(myBalance).toLocaleString(undefined, {minimumFractionDigits: 2})}`;
  }
  document.getElementById('statSettlementsCount').innerText = Object.keys(setRes.balances).length;

  const indGrid = document.getElementById('individualBalancesGrid');
  indGrid.innerHTML = roommatesData.map(s => {
    const bal = setRes.balances_by_id[String(s.id)] || 0;
    const isMe = s.id === currentUser.id;
    const savedPic = localStorage.getItem(`avatar_slot_${s.id}`);

    return `
      <div class="card glass-card" style="margin:0;">
        <div class="flex-between">
          <div style="display:flex; align-items:center; gap:8px;">
            <div class="avatar-sm-wrapper">
              ${savedPic ? `<img src="${savedPic}" class="avatar-sm-img" />` : `<span class="avatar-sm">${s.name.charAt(0)}</span>`}
            </div>
            <strong>${s.name} ${isMe ? '(You)' : ''}</strong>
          </div>
          <span style="font-size: 11px; color:var(--text-muted);">Room 7</span>
        </div>
        <div style="margin-top: 10px;">
          <span class="${bal >= 0 ? 'pos-val' : 'neg-val'}" style="font-size: 16px;">
            ${bal >= 0 ? '+' : ''}₦${bal.toLocaleString(undefined, {minimumFractionDigits: 2})}
          </span>
          <small class="subtitle" style="display:block;">${bal >= 0 ? 'is owed' : 'owes'}</small>
        </div>
      </div>
    `;
  }).join('');

  const expList = document.getElementById('expenseActivityList');
  if (expensesData.length === 0) {
    expList.innerHTML = '<p class="subtitle">No expenses logged yet.</p>';
  } else {
    expList.innerHTML = expensesData.slice().reverse().map(exp => {
      const payerObj = roommatesData.find(s => s.id === Number(exp.paid_by)) || { name: `Slot ${exp.paid_by}` };
      return `
        <div class="list-card-item">
          <div>
            <strong>${exp.title}</strong>
            <p class="subtitle">${payerObj.name} paid • ${exp.category} • ${new Date(exp.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span class="font-bold" style="color: #34d399;">₦${Number(exp.amount).toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
            <button class="btn-danger-sm" onclick="deleteExpense(${exp.id})">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

async function renderRoommatesProfiles() {
  const container = document.getElementById('roommatesProfileGrid');
  container.innerHTML = roommatesData.map(s => {
    const savedPic = localStorage.getItem(`avatar_slot_${s.id}`);
    return `
      <div class="card glass-card" style="margin:0; text-align: left;">
        <div class="flex-between" style="margin-bottom: 8px;">
          <div class="avatar-sm-wrapper">
            ${savedPic ? `<img src="${savedPic}" class="avatar-sm-img" />` : `<span class="avatar-sm">${s.name.charAt(0)}</span>`}
          </div>
          <span style="font-size: 11px; color: ${s.registered ? '#34d399' : 'var(--text-muted)'};">
            ${s.registered ? '● Active' : '○ Not set up'}
          </span>
        </div>
        <strong>${s.name}</strong>
        <p class="subtitle">Room 7 • Slot ${s.id}</p>
      </div>
    `;
  }).join('');
}

async function renderCartView() {
  const res = await apiFetch('/api/cart');
  const cartList = document.getElementById('cartItemList');
  if (res.items.length === 0) {
    cartList.innerHTML = '<p class="subtitle">Shopping cart is empty.</p>';
    return;
  }
  cartList.innerHTML = res.items.map(item => `
    <div class="list-card-item">
      <div style="display: flex; align-items: center; gap: 10px;">
        <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="toggleCartItem(${item.id}, ${!item.checked})" style="width: 18px; height: 18px; accent-color:var(--accent-cyan);" />
        <span style="${item.checked ? 'text-decoration: line-through; color: var(--text-muted);' : ''}">${item.name} (${item.quantity}x) - ₦${(item.price * item.quantity).toLocaleString()}</span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="btn btn-outline-sm" onclick="convertCartToExpense('${item.name}', ${item.price * item.quantity})">Convert to Expense</button>
        <button class="btn-danger-sm" onclick="deleteCartItem(${item.id})">✕</button>
      </div>
    </div>
  `).join('');
}

async function convertCartToExpense(itemName, totalAmount) {
  const allIds = roommatesData.map(s => s.id);
  try {
    await apiFetch('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({
        title: `Cart Item: ${itemName}`,
        amount: totalAmount,
        category: 'Groceries',
        paid_by: currentUser.id,
        split_among: allIds
      }),
    });
    alert('Cart item successfully converted and synced as a shared expense!');
    refreshAppData();
  } catch (err) {
    alert(err.message);
  }
}

async function renderReceiptsView() {
  const setRes = await apiFetch('/api/settle');
  const planList = document.getElementById('settlementPlanList');
  const balanceEntries = Object.entries(setRes.balances).filter(([name, val]) => Math.abs(val) > 0.01);
  
  if (balanceEntries.length === 0) {
    planList.innerHTML = '<p class="subtitle">All accounts are fully settled!</p>';
  } else {
    planList.innerHTML = balanceEntries.map(([name, bal]) => `
      <div class="list-card-item">
        <span>${name} Balance</span>
        <span class="${bal >= 0 ? 'pos-val' : 'neg-val'}">${bal >= 0 ? '+' : ''}₦${bal.toLocaleString(undefined, {minimumFractionDigits: 2})}</span>
      </div>
    `).join('');
  }

  const receiptsContainer = document.getElementById('digitalReceiptsList');
  if (expensesData.length === 0) {
    receiptsContainer.innerHTML = '<p class="subtitle">No receipts available.</p>';
  } else {
    receiptsContainer.innerHTML = expensesData.slice().reverse().map((exp, idx) => `
      <div class="card glass-card" style="margin-bottom: 12px;">
        <div class="flex-between">
          <strong>Receipt #${expensesData.length - idx}</strong>
          <small class="subtitle">${new Date(exp.timestamp).toLocaleString()}</small>
        </div>
        <hr style="border:0; border-top:1px solid rgba(255,255,255,0.08); margin: 10px 0;" />
        <p><strong>Item/Title:</strong> ${exp.title}</p>
        <p><strong>Category:</strong> ${exp.category}</p>
        <p><strong>Total Amount:</strong> ₦${Number(exp.amount).toLocaleString()}</p>
        <button class="btn btn-outline-sm" style="margin-top: 10px;" onclick="window.print()">🖨️ Print Receipt / Export PDF</button>
      </div>
    `).join('');
  }
}

async function submitExpense(e) {
  e.preventDefault();
  const title = document.getElementById('expTitle').value;
  const amount = parseFloat(document.getElementById('expAmount').value);
  const category = document.getElementById('expCategory').value;

  const checkboxes = document.querySelectorAll('#splitCheckboxes input:checked');
  const split_among = Array.from(checkboxes).map(cb => parseInt(cb.value));

  if (split_among.length === 0) {
    alert('Please select at least one roommate to split with.');
    return;
  }

  try {
    await apiFetch('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ title, amount, category, paid_by: currentUser.id, split_among }),
    });
    document.getElementById('expenseForm').reset();
    document.querySelectorAll('#splitCheckboxes input').forEach(cb => cb.checked = true);
    refreshAppData();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteExpense(id) {
  if (!confirm('Are you sure you want to delete this payment expense?')) return;
  try {
    await apiFetch(`/api/expenses/${id}`, { method: 'DELETE' });
    refreshAppData();
  } catch (err) {
    alert(err.message);
  }
}

async function submitCartItem(e) {
  e.preventDefault();
  const name = document.getElementById('cartName').value;
  const price = parseFloat(document.getElementById('cartPrice').value);
  const quantity = parseInt(document.getElementById('cartQty').value);

  try {
    await apiFetch('/api/cart', {
      method: 'POST',
      body: JSON.stringify({ name, price, quantity, added_by: currentUser.id }),
    });
    document.getElementById('cartForm').reset();
    refreshAppData();
  } catch (err) {
    alert(err.message);
  }
}

async function toggleCartItem(id, checked) {
  await apiFetch(`/api/cart/${id}`, { method: 'PATCH', body: JSON.stringify({ checked }) });
  refreshAppData();
}

async function deleteCartItem(id) {
  await apiFetch(`/api/cart/${id}`, { method: 'DELETE' });
  refreshAppData();
}

async function clearCheckedCart() {
  await apiFetch('/api/cart/checked', { method: 'DELETE' });
  refreshAppData();
}

async function submitChangePin(e) {
  e.preventDefault();
  const currentPin = document.getElementById('oldPin').value;
  const newPin = document.getElementById('newPin').value;
  const errDiv = document.getElementById('pinChangeError');
  errDiv.innerText = '';

  try {
    await apiFetch('/api/auth/set-pin', {
      method: 'POST',
      body: JSON.stringify({ student_id: currentUser.id, current_pin: currentPin, new_pin: newPin }),
    });
    alert('PIN updated successfully!');
    document.getElementById('oldPin').value = '';
    document.getElementById('newPin').value = '';
  } catch (err) {
    errDiv.innerText = err.message;
  }
}

function switchTab(tabName, btnElement) {
  document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
  document.querySelectorAll('.bottom-nav .nav-item').forEach(nav => nav.classList.remove('active'));

  document.getElementById(`view-${tabName}`).classList.add('active');
  btnElement.classList.add('active');
}