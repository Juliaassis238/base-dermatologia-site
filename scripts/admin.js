import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.BASE_AGENDA_CONFIG || {};
const apiBase = String(config.apiBaseUrl || '').replace(/\/+$/, '');
const anonKey = String(config.anonKey || '');
const supabaseUrl = apiBase.replace(/\/functions\/v1\/agenda$/, '');
const $ = (selector) => document.querySelector(selector);
const loginPanel = $('#login-panel');
const loginForm = $('#login-form');
const loginStatus = $('#auth-status');
loginForm.elements.email.value = '';
const passwordForm = $('#password-form');
const passwordStatus = $('#password-status');
const dashboard = $('#dashboard');
const dashboardStatus = $('#dashboard-status');
const bookingList = $('#booking-list');
const scheduleBoard = $('#schedule-board');
const filtersForm = $('#filters-form');
const searchInput = $('#search-bookings');
const statusFilter = $('#status-filter');
const previousButton = $('#previous-page');
const nextButton = $('#next-page');
const pageLabel = $('#page-label');
const editDialog = $('#edit-dialog');
const editForm = $('#edit-form');
const editStatus = $('#edit-status');
const editSlotSelect = editForm.elements.new_slot_id;
const slotField = editSlotSelect.closest('label');
const records = new Map();
let supabase = null;
let session = null;
let page = 1;
let hasMore = false;
let editingRecord = null;
let changingState = false;

const statusLabels = {
  pending_payment: 'Aguardando pagamento',
  payment_review: 'Comprovante enviado · conferir Pix',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  expired: 'Expirada',
};
const brDateTime = (value) => value
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : '—';
const brTime = (value) => value
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : '—';
const brMoney = (cents) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents || 0) / 100);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function localDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, numberOfDays) {
  const date = new Date(`${dateKey}T12:00:00-03:00`);
  date.setDate(date.getDate() + numberOfDays);
  return localDateKey(date);
}

function showSignedOut(message = '') {
  session = null;
  page = 1;
  searchInput.value = '';
  statusFilter.value = '';
  passwordForm.reset();
  loginForm.elements.email.value = '';
  loginForm.elements.password.value = '';
  loginPanel.hidden = false;
  dashboard.hidden = true;
  loginStatus.textContent = message;
}

async function showSignedIn(userSession) {
  if (!userSession?.access_token) return showSignedOut();
  session = userSession;
  try {
    const authorization = await apiRequest('admin-appointments?page=1');
    if (!session) return;
    loginPanel.hidden = true;
    dashboard.hidden = false;
    await loadAppointments(authorization);
  } catch (error) {
    if (session) await supabase.auth.signOut({ scope: 'local' });
    const message = error.message === 'Acesso não autorizado.'
      ? 'O e-mail digitado não está autorizado para acessar o painel.'
      : 'Não foi possível validar o acesso ao painel. Confira as credenciais e tente novamente.';
    showSignedOut(message);
  }
}

async function apiRequest(endpoint, options = {}) {
  if (!session?.access_token) throw new Error('Sua sessão expirou. Entre novamente com o e-mail e a senha da clínica.');
  const response = await fetch(`${apiBase}/${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${session.access_token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) {
    const authMessage = result.message === 'Acesso não autorizado.'
      ? 'Esse e-mail não está autorizado para administrar os agendamentos.'
      : 'Sua sessão expirou. Entre novamente com o e-mail e a senha da clínica.';
    await supabase.auth.signOut({ scope: 'local' });
    showSignedOut(authMessage);
  }
  if (!response.ok) throw new Error(result.message || 'Não foi possível concluir esta operação.');
  return result;
}

function fullAddress(record) {
  const number = record.patient_address_number ? `, ${record.patient_address_number}` : '';
  const complement = record.patient_address_complement ? ` · ${record.patient_address_complement}` : '';
  const neighborhood = record.patient_address_neighborhood ? ` · ${record.patient_address_neighborhood}` : '';
  const city = [record.patient_address_city, record.patient_address_state].filter(Boolean).join(' / ');
  const cityPart = city ? ` · ${city}` : '';
  const postal = record.patient_address_postal_code ? ` · CEP ${record.patient_address_postal_code}` : '';
  return `${record.patient_address_line || ''}${number}${complement}${neighborhood}${cityPart}${postal}`;
}

function renderSchedule(items) {
  if (!items.length) {
    scheduleBoard.innerHTML = '<div class="schedule-empty">Nenhuma marcação para exibir com esses filtros.</div>';
    return;
  }
  const grouped = new Map();
  const ordered = [...items].filter((record) => record.starts_at).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  for (const record of ordered) {
    const dayKey = localDateKey(new Date(record.starts_at));
    if (!grouped.has(dayKey)) {
      grouped.set(dayKey, {
        label: new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(record.starts_at)),
        doctors: new Map(),
      });
    }
    const day = grouped.get(dayKey);
    const doctorName = record.doctor_name || 'Equipe Base Dermatologia';
    if (!day.doctors.has(doctorName)) day.doctors.set(doctorName, []);
    day.doctors.get(doctorName).push(record);
  }
  scheduleBoard.innerHTML = [...grouped.entries()].map(([dayKey, day]) => {
    const doctorGroups = [...day.doctors.entries()].map(([doctorName, appointments]) => {
      const rows = appointments.map((record) => `<div class="schedule-slot" data-status="${escapeHtml(record.status)}">
        <time class="schedule-slot__time">${escapeHtml(brTime(record.starts_at))}–${escapeHtml(brTime(record.ends_at))}</time>
        <span class="schedule-slot__patient">${escapeHtml(record.patient_name || 'Paciente')} · ${escapeHtml(String(record.id).slice(0, 8).toUpperCase())}</span>
        <span class="schedule-slot__status">${escapeHtml(statusLabels[record.status] || record.status)}</span>
      </div>`).join('');
      return `<section class="schedule-doctor" aria-label="${escapeHtml(doctorName)}"><h4 class="schedule-doctor__title">${escapeHtml(doctorName)} <span>${appointments.length} horário(s)</span></h4><div class="schedule-doctor__slots">${rows}</div></section>`;
    }).join('');
    return `<section class="schedule-day" data-day="${escapeHtml(dayKey)}"><h4 class="schedule-day__title">${escapeHtml(day.label)}</h4><div class="schedule-day__doctors">${doctorGroups}</div></section>`;
  }).join('');
}

function renderAppointments(items) {
  records.clear();
  for (const record of items) records.set(record.id, record);
  renderSchedule(items);
  if (!items.length) {
    bookingList.innerHTML = '<div class="booking-card__empty">Nenhum agendamento encontrado com esses filtros.</div>';
    return;
  }
  bookingList.innerHTML = items.map((record) => {
    const id = escapeHtml(record.id);
    const status = escapeHtml(record.status);
    const label = escapeHtml(statusLabels[record.status] || 'Situação desconhecida');
    const name = escapeHtml(record.patient_name || 'Paciente');
    const doctor = escapeHtml(record.doctor_name || 'Equipe Base Dermatologia');
    const amount = brMoney(record.deposit_amount_cents);
    const phone = escapeHtml(record.patient_phone || '—');
    const email = escapeHtml(record.patient_email || '—');
    const cpf = escapeHtml(record.patient_cpf || '—');
    const address = escapeHtml(fullAddress(record) || '—');
    const date = escapeHtml(brDateTime(record.starts_at));
    const created = escapeHtml(brDateTime(record.created_at));
    const proofMessage = record.status === 'payment_review'
      ? '<p><strong>Comprovante:</strong> paciente informou que enviou pelo WhatsApp. Conferir o crédito na conta Pix.</p>'
      : '';
    const approveButton = ['pending_payment', 'payment_review'].includes(record.status)
      ? '<button class="button" type="button" data-action="approve">Conferir Pix e liberar</button>' : '';
    const cancelButton = !['cancelled', 'expired'].includes(record.status)
      ? '<button class="button button--danger" type="button" data-action="cancel">Cancelar marcação</button>' : '';
    const balanceNote = record.payment_status === 'received'
      ? '<p><strong>Pix:</strong> marcado como conferido pela clínica.</p>'
      : `<p><strong>Pix:</strong> ${escapeHtml(record.payment_status || 'pendente')} · sinal de ${amount}</p>`;
    return `<article class="booking-card" data-booking-id="${id}">
      <div class="booking-card__top"><div><h3 class="booking-card__title">${name}</h3><p class="booking-card__meta">${doctor} · ${date}</p><p class="booking-card__meta">Código ${escapeHtml(String(record.id).slice(0, 8).toUpperCase())} · criado ${created}</p></div><span class="booking-card__status" data-status="${status}">${label}</span></div>
      <div class="booking-card__info"><p><strong>Telefone:</strong> ${phone}</p><p><strong>E-mail:</strong> ${email}</p><p><strong>CPF:</strong> ${cpf}</p><p><strong>Endereço:</strong> ${address}</p>${balanceNote}${proofMessage}</div>
      <div class="booking-card__buttons"><button class="button button--quiet" type="button" data-action="edit">Editar dados ou horário</button>${approveButton}${cancelButton}</div>
    </article>`;
  }).join('');
}

async function loadAppointments(preloadedResult = null) {
  if (!session) return;
  dashboardStatus.textContent = 'Carregando agendamentos…';
  bookingList.setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams({ page: String(page) });
    if (statusFilter.value) params.set('status', statusFilter.value);
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    const result = preloadedResult || await apiRequest(`admin-appointments?${params.toString()}`);
    const items = Array.isArray(result.appointments) ? result.appointments : [];
    renderAppointments(items);
    hasMore = Boolean(result.hasMore);
    pageLabel.textContent = `Página ${page}`;
    previousButton.disabled = page <= 1;
    nextButton.disabled = !hasMore;
    dashboardStatus.textContent = `${items.length} agendamento(s) nesta página.`;
  } catch (error) {
    dashboardStatus.textContent = error.message || 'Não foi possível carregar os agendamentos.';
    bookingList.innerHTML = '';
  } finally {
    bookingList.removeAttribute('aria-busy');
  }
}

function appendSlotOptions(slots, currentRecord) {
  const seen = new Set();
  const usable = slots.filter((slot) => {
    if (!slot?.id || !slot.startsAt || slot.id === currentRecord.slot_id || seen.has(slot.id)) return false;
    seen.add(slot.id);
    return true;
  }).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  if (!usable.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nenhum outro horário livre disponível';
    editSlotSelect.append(option);
    return;
  }
  for (const slot of usable) {
    const option = document.createElement('option');
    option.value = slot.id;
    option.textContent = `${brDateTime(slot.startsAt)} · ${slot.doctorName}`;
    editSlotSelect.append(option);
  }
}

async function loadOpenSlots(currentRecord) {
  editSlotSelect.disabled = true;
  editSlotSelect.innerHTML = '<option value="">Carregando horários disponíveis…</option>';
  const allSlots = [];
  try {
    const start = localDateKey(new Date());
    for (let segment = 0; segment < 3; segment += 1) {
      const from = shiftDateKey(start, segment * 30);
      const to = shiftDateKey(from, 29);
      const response = await fetch(`${apiBase}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        headers: { Accept: 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'Não foi possível consultar os horários livres.');
      if (Array.isArray(result.slots)) allSlots.push(...result.slots);
    }
    editSlotSelect.innerHTML = '<option value="">Manter horário atual</option>';
    appendSlotOptions(allSlots, currentRecord);
    editSlotSelect.disabled = false;
  } catch (error) {
    editSlotSelect.innerHTML = '<option value="">Horários indisponíveis para consulta</option>';
    editStatus.textContent = error.message || 'Não foi possível carregar horários livres.';
  }
}

async function openEditor(record) {
  editingRecord = record;
  editStatus.textContent = '';
  editForm.reset();
  editForm.elements.appointmentId.value = record.id;
  const fields = [
    'patient_name', 'patient_email', 'patient_phone', 'patient_cpf',
    'patient_address_line', 'patient_address_number', 'patient_address_complement',
    'patient_address_neighborhood', 'patient_address_city', 'patient_address_state',
    'patient_address_postal_code',
  ];
  for (const field of fields) editForm.elements[field].value = record[field] || '';
  $('#edit-booking-summary').textContent = `${record.doctor_name || 'Equipe Base Dermatologia'} · ${brDateTime(record.starts_at)} · ${statusLabels[record.status] || record.status}`;
  const canReschedule = ['pending_payment', 'payment_review', 'confirmed'].includes(record.status);
  slotField.hidden = !canReschedule;
  if (canReschedule) void loadOpenSlots(record);
  editDialog.showModal();
}

async function changeAppointment(appointmentId, action, button) {
  const record = records.get(appointmentId);
  if (!record || changingState) return;
  if (action === 'approve') {
    const accepted = window.confirm(`Confirma que verificou o crédito Pix de R$ 125,00 de ${record.patient_name}? Só libere a marcação após confirmar o recebimento na conta da profissional.`);
    if (!accepted) return;
  } else if (action === 'cancel') {
    const refundNotice = record.payment_status === 'received' ? '\n\nO valor Pix não será estornado automaticamente; trate eventual reembolso separadamente.' : '';
    const accepted = window.confirm(`Cancelar a marcação de ${record.patient_name} para ${brDateTime(record.starts_at)}?${refundNotice}`);
    if (!accepted) return;
  }
  changingState = true;
  button.disabled = true;
  dashboardStatus.textContent = 'Salvando alteração…';
  try {
    const result = await apiRequest('admin-appointment', {
      method: 'POST', body: { appointmentId, action },
    });
    dashboardStatus.textContent = result.message || 'Alteração concluída.';
    await loadAppointments();
  } catch (error) {
    dashboardStatus.textContent = error.message || 'Não foi possível salvar a alteração.';
    button.disabled = false;
  } finally {
    changingState = false;
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabase) return;
  const button = $('#login-submit');
  const credentials = new FormData(loginForm);
  const email = String(credentials.get('email') || '').trim().toLowerCase();
  const password = String(credentials.get('password') || '');
  button.disabled = true;
  loginStatus.textContent = 'Verificando as credenciais…';
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    loginStatus.textContent = 'Credenciais corretas. Validando autorização do painel…';
  } catch {
    loginStatus.textContent = 'Não foi possível entrar. Confira o e-mail e a senha e tente novamente.';
  } finally {
    loginForm.elements.email.value = '';
    loginForm.elements.password.value = '';
    button.disabled = false;
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!supabase || !session) return;
  const values = new FormData(passwordForm);
  const currentPassword = String(values.get('currentPassword') || '');
  const newPassword = String(values.get('newPassword') || '');
  const confirmPassword = String(values.get('confirmPassword') || '');
  const sessionEmail = String(session.user?.email || '').trim().toLowerCase();
  const button = $('#save-password');
  passwordStatus.textContent = '';
  if (!sessionEmail) {
    passwordStatus.textContent = 'Entre novamente antes de alterar a senha.';
    return;
  }
  if (newPassword.length < 12) {
    passwordStatus.textContent = 'Escolha uma senha com pelo menos 12 caracteres.';
    return;
  }
  if (newPassword !== confirmPassword) {
    passwordStatus.textContent = 'A confirmação não corresponde à nova senha.';
    return;
  }
  if (newPassword === currentPassword) {
    passwordStatus.textContent = 'A nova senha deve ser diferente da senha atual.';
    return;
  }
  button.disabled = true;
  passwordStatus.textContent = 'Atualizando a senha compartilhada…';
  try {
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email: sessionEmail, password: currentPassword });
    if (verifyError) throw new Error('A senha atual não confere.');
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) throw updateError;
    const { data: verified, error: newPasswordError } = await supabase.auth.signInWithPassword({ email: sessionEmail, password: newPassword });
    if (newPasswordError || !verified.session) {
      await supabase.auth.signOut({ scope: 'local' });
      showSignedOut('Senha alterada. Entre novamente usando a nova senha compartilhada.');
      return;
    }
    session = verified.session;
    passwordForm.reset();
    passwordStatus.textContent = 'Senha alterada. A nova senha será usada pelas duas doutoras.';
  } catch (error) {
    passwordStatus.textContent = error.message || 'Não foi possível alterar a senha agora.';
  } finally {
    passwordForm.reset();
    button.disabled = false;
  }
});

filtersForm.addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  void loadAppointments();
});
previousButton.addEventListener('click', () => {
  if (page <= 1) return;
  page -= 1;
  void loadAppointments();
});
nextButton.addEventListener('click', () => {
  if (!hasMore) return;
  page += 1;
  void loadAppointments();
});
$('#sign-out').addEventListener('click', async () => {
  await supabase.auth.signOut({ scope: 'local' });
  showSignedOut('Você saiu do painel.');
});
bookingList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const card = button.closest('[data-booking-id]');
  const record = records.get(card?.dataset.bookingId);
  if (!record) return;
  if (button.dataset.action === 'edit') void openEditor(record);
  else void changeAppointment(record.id, button.dataset.action, button);
});
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!editingRecord || changingState) return;
  const form = new FormData(editForm);
  const changes = {};
  const fields = [
    'patient_name', 'patient_email', 'patient_phone', 'patient_cpf',
    'patient_address_line', 'patient_address_number', 'patient_address_complement',
    'patient_address_neighborhood', 'patient_address_city', 'patient_address_state',
    'patient_address_postal_code',
  ];
  for (const field of fields) {
    const value = String(form.get(field) || '').trim();
    const previous = String(editingRecord[field] || '');
    const normalizedPrevious = field === 'patient_address_complement' ? previous.trim() : previous;
    if (value !== normalizedPrevious) changes[field] = value || null;
  }
  const newSlotId = String(form.get('new_slot_id') || '');
  if (newSlotId) changes.new_slot_id = newSlotId;
  if (!Object.keys(changes).length) {
    editStatus.textContent = 'Nenhuma alteração foi feita.';
    return;
  }
  const button = $('#save-edit');
  button.disabled = true;
  changingState = true;
  editStatus.textContent = 'Salvando alterações…';
  try {
    const result = await apiRequest('admin-appointment', {
      method: 'POST', body: { appointmentId: editingRecord.id, action: 'edit', changes },
    });
    editStatus.textContent = result.message || 'Alterações salvas.';
    editDialog.close();
    await loadAppointments();
  } catch (error) {
    editStatus.textContent = error.message || 'Não foi possível salvar as alterações.';
  } finally {
    button.disabled = false;
    changingState = false;
  }
});
function closeEditor() { editDialog.close(); }
$('#close-edit').addEventListener('click', closeEditor);
$('#cancel-edit').addEventListener('click', closeEditor);
editDialog.addEventListener('click', (event) => {
  if (event.target === editDialog) closeEditor();
});

async function initialize() {
  if (!apiBase || !anonKey || !supabaseUrl) {
    showSignedOut('O painel ainda não foi configurado.');
    $('#login-submit').disabled = true;
    return;
  }
  try {
    const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
    try {
      window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
    } catch {
      // O armazenamento pode estar indisponível em alguns navegadores.
    }
    supabase = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: true, persistSession: false, detectSessionInUrl: false },
    });
    supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === 'SIGNED_OUT') showSignedOut();
      if (event === 'SIGNED_IN' && newSession) void showSignedIn(newSession);
    });
    showSignedOut();
  } catch (error) {
    showSignedOut(error.message || 'Não foi possível inicializar o acesso seguro.');
  }
}

window.addEventListener('pagehide', () => {
  session = null;
  loginForm.reset();
  passwordForm.reset();
  loginPanel.hidden = false;
  dashboard.hidden = true;
  if (supabase) void supabase.auth.signOut({ scope: 'local' });
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  if (supabase) void supabase.auth.signOut({ scope: 'local' });
  showSignedOut('Por segurança, entre novamente para acessar a agenda.');
});

void initialize();
