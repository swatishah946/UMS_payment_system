// Small demo client for the payment module. Talks to the same APIs the real
// ERP frontend would use. No framework, just fetch + DOM.

const OPEN = ['CREATED', 'ACTIVE', 'PENDING', 'FAILED', 'USER_DROPPED'];

const studentSelect = document.getElementById('student');
let currentStudentId = null;

// ---------- api helper ----------

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join(', ') : data.message;
    const err = new Error(`${data.code || res.status}: ${msg || 'request failed'}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

// cancel / reconcile are admin routes. if the server has ADMIN_API_KEY set,
// ask for the key once and keep it for this browser tab
async function adminApi(method, url, body) {
  const headers = () => {
    try {
      const key = sessionStorage.getItem('adminKey');
      return key ? { 'x-admin-key': key } : {};
    } catch {
      return {};
    }
  };
  try {
    return await api(method, url, body, headers());
  } catch (e) {
    if (e.code !== 'ADMIN_KEY_REQUIRED') throw e;
    const key = prompt('Admin key required for this action:');
    if (!key) throw e;
    try {
      sessionStorage.setItem('adminKey', key);
    } catch {
      // storage blocked, key is only used for this one request
    }
    return api(method, url, body, { 'x-admin-key': key });
  }
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 4000);
}

const rupees = (v) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 });
const when = (d) => (d ? new Date(d).toLocaleString('en-IN') : '-');
const badge = (s) => `<span class="badge ${s}">${s}</span>`;

// ---------- students ----------

async function loadStudents() {
  const students = await api('GET', '/students');
  studentSelect.innerHTML = students
    .map((s) => `<option value="${s.id}">${s.rollNumber} – ${s.name}</option>`)
    .join('');
  return students;
}

studentSelect.addEventListener('change', () => selectStudent(studentSelect.value));

async function selectStudent(id) {
  currentStudentId = id;
  studentSelect.value = id;
  await Promise.all([loadInvoices(), loadPayments()]);
}

// ---------- invoices ----------

async function loadInvoices() {
  const box = document.getElementById('invoices');
  const invoices = await api('GET', `/students/${currentStudentId}/invoices`);
  if (!invoices.length) {
    box.innerHTML = '<p class="muted">No invoices.</p>';
    return;
  }
  box.innerHTML = `
    <div class="table-scroll"><table>
      <tr><th>Invoice</th><th>Type</th><th>Amount</th><th>Status</th><th></th></tr>
      ${invoices
        .map(
          (i) => `<tr>
            <td>${i.title}</td>
            <td>${i.feeType}</td>
            <td>${rupees(i.amount)}</td>
            <td>${badge(i.status)}</td>
            <td><button data-pay="${i.id}" ${i.status !== 'UNPAID' ? 'disabled' : ''}>
              ${i.status === 'PAID' ? 'Paid' : 'Pay'}</button></td>
          </tr>`,
        )
        .join('')}
    </table></div>`;

  box
    .querySelectorAll('[data-pay]')
    .forEach((btn) => btn.addEventListener('click', () => pay(btn.dataset.pay, btn)));
}

// ---------- pay ----------

async function pay(invoiceId, btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    // one key per click: if this request is retried, the backend returns the same order
    const order = await api(
      'POST',
      '/payments/orders',
      { invoiceId, studentId: currentStudentId },
      { 'Idempotency-Key': crypto.randomUUID() },
    );

    if (typeof Cashfree === 'undefined') {
      throw new Error('Cashfree SDK did not load (check internet connection)');
    }
    const cashfree = Cashfree({
      mode: order.cashfreeMode === 'production' ? 'production' : 'sandbox',
    });
    // leaves this page, cashfree redirects back to PAYMENT_RETURN_URL (?order_id=...)
    await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' });
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = 'Pay';
  }
}

// ---------- payment history ----------

async function loadPayments() {
  const box = document.getElementById('payments');
  const orders = await api('GET', `/students/${currentStudentId}/payments`);
  if (!orders.length) {
    box.innerHTML = '<p class="muted">No payments yet.</p>';
    return;
  }
  box.innerHTML = `
    <div class="table-scroll"><table>
      <tr><th>Order</th><th>Invoice</th><th>Amount</th><th>Status</th><th>Created</th><th></th></tr>
      ${orders
        .map(
          (o) => `<tr>
            <td class="mono">${o.orderId}</td>
            <td>${o.invoice.title}</td>
            <td>${rupees(o.amount)}</td>
            <td>${badge(o.status)}${o.failureReason ? `<div class="muted">${o.failureReason}</div>` : ''}</td>
            <td>${when(o.createdAt)}</td>
            <td class="actions">
              <button class="secondary" data-details="${o.id}">Details</button>
              <button class="secondary" data-verify="${o.id}">Verify</button>
              ${
                OPEN.includes(o.status) && o.status !== 'PENDING'
                  ? `<button class="danger" data-cancel="${o.id}">Cancel</button>`
                  : ''
              }
            </td>
          </tr>`,
        )
        .join('')}
    </table></div>`;

  box
    .querySelectorAll('[data-details]')
    .forEach((b) => b.addEventListener('click', () => showDetails(b.dataset.details)));
  box
    .querySelectorAll('[data-verify]')
    .forEach((b) => b.addEventListener('click', () => verify(b.dataset.verify)));
  box
    .querySelectorAll('[data-cancel]')
    .forEach((b) => b.addEventListener('click', () => cancel(b.dataset.cancel)));
}

async function verify(id) {
  try {
    const order = await api('POST', `/payments/orders/${id}/verify`);
    showResult(order);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function cancel(id) {
  if (!confirm('Cancel this payment order?')) return;
  try {
    const order = await adminApi('POST', `/payments/orders/${id}/cancel`, {
      reason: 'cancelled from demo page',
    });
    toast(`Order is now ${order.status}`);
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function showDetails(id) {
  try {
    showResult(await api('GET', `/payments/orders/${id}`));
  } catch (e) {
    toast(e.message);
  }
}

document.getElementById('reconcile').addEventListener('click', async () => {
  try {
    const r = await adminApi('POST', '/payments/reconcile');
    toast(
      r.skipped
        ? 'Already running'
        : `Checked ${r.checked}, changed ${r.changed}, failed ${r.failed}`,
    );
    await refresh();
  } catch (e) {
    toast(e.message);
  }
});

function refresh() {
  return Promise.all([loadInvoices(), loadPayments()]);
}

// ---------- order result card ----------

const MESSAGES = {
  PAID: 'Payment successful. The invoice is marked as paid.',
  PENDING: 'Payment is being processed by the bank. Check again in a minute.',
  FAILED: 'Payment failed. You can try again.',
  USER_DROPPED: 'Checkout was closed before paying. You can try again.',
  ACTIVE: 'No payment received yet for this order.',
  EXPIRED: 'This order expired. Start a new payment.',
  CANCELLED: 'This order was cancelled.',
  FLAGGED: 'Payment received but needs manual review by accounts.',
};

function showResult(order) {
  const box = document.getElementById('result');
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="result-title">
      <h2 style="margin:0">${order.invoice?.title ?? 'Payment'}</h2>${badge(order.status)}
    </div>
    <p>${MESSAGES[order.status] ?? ''}</p>
    <p class="muted mono">${order.orderId} · ${rupees(order.amount)}</p>

    <h2>Attempts</h2>
    ${
      order.transactions?.length
        ? `<div class="table-scroll"><table>
            <tr><th>Cashfree payment id</th><th>Method</th><th>Status</th><th>Time</th><th>Message</th></tr>
            ${order.transactions
              .map(
                (t) => `<tr><td class="mono">${t.cfPaymentId}</td><td>${t.paymentGroup ?? '-'}</td>
                  <td>${badge(t.status)}</td><td>${when(t.paymentTime)}</td>
                  <td>${t.paymentMessage ?? ''}</td></tr>`,
              )
              .join('')}
          </table></div>`
        : '<p class="muted">No attempts yet.</p>'
    }

    <h2 style="margin-top:12px">Status history</h2>
    <ul class="timeline">
      ${(order.history ?? [])
        .map(
          (h) => `<li>${h.fromStatus ?? 'new'} → <b>${h.toStatus}</b>
            <span class="muted">via ${h.source} · ${when(h.createdAt)}${h.note ? ' · ' + h.note : ''}</span></li>`,
        )
        .join('')}
    </ul>`;
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---------- start ----------

async function init() {
  try {
    const students = await loadStudents();

    // back from cashfree checkout: verify the order, never trust the redirect itself
    const orderId = new URLSearchParams(location.search).get('order_id');
    if (orderId) {
      const box = document.getElementById('result');
      box.classList.remove('hidden');
      box.innerHTML = '<p>Verifying payment with Cashfree…</p>';
      const order = await api('POST', `/payments/orders/${encodeURIComponent(orderId)}/verify`);
      await selectStudent(order.studentId);
      showResult(order);
      history.replaceState(null, '', '/'); // clean the url so refresh doesn't re-verify
      return;
    }

    if (students.length) await selectStudent(students[0].id);
  } catch (e) {
    toast(e.message);
  }
}

init();
