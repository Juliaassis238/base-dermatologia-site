(() => {
  'use strict';

  const config = window.BASE_AGENDA_CONFIG || {};
  const apiBase = String(config.apiBaseUrl || '').replace(/\/+$/, '');
  const privacyUrl = String(config.privacyUrl || '');
  const demo = !apiBase && new URLSearchParams(window.location.search).get('demo') === '1';
  const anonKey = String(config.anonKey || '');
  const privacyVersion = String(config.privacyVersion || '');
  const liveReady = Boolean(apiBase && privacyUrl && privacyVersion && anonKey);
  const zone = 'America/Sao_Paulo';
  const $ = (selector) => document.querySelector(selector);
  const configuredStartDate = String(config.firstAvailableDate || '');
  const configuredMonth = /^\d{4}-\d{2}-\d{2}$/.test(configuredStartDate)
    ? new Date(`${configuredStartDate}T12:00:00-03:00`)
    : new Date();
  const currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
  const configuredStartMonth = new Date(configuredMonth.getFullYear(), configuredMonth.getMonth(), 1, 12);
  const initialMonth = configuredStartMonth > currentMonth ? configuredStartMonth : currentMonth;
  const state = {
    month: initialMonth,
    slots: [],
    selectedDay: '',
    selectedSlot: null,
    loading: false,
    requestId: 0
  };

  const monthLabel = $('#agenda-month');
  const daysGrid = $('#agenda-days');
  const slotsHost = $('#agenda-slots');
  const notice = $('#agenda-notice');
  const statusLine = $('#agenda-feedback');
  const bookingForm = $('#agenda-form');
  const patientFields = [...bookingForm.querySelectorAll('input')];
  const privacyCheck = $('#agenda-privacy-check');
  const submitButton = $('#agenda-submit');
  const summaryTitle = $('#agenda-summary-title');
  const summaryDetail = $('#agenda-summary-detail');
  const privacyLink = $('#agenda-privacy-link');
  const paymentPanel = $('#agenda-payment');
  const paymentDetail = $('#agenda-payment-detail');
  const paymentQr = $('#agenda-payment-qr');
  const whatsappLink = $('#agenda-whatsapp-link');
  const proofSentButton = $('#agenda-proof-sent');
  const paymentStatus = $('#agenda-payment-status');
  const cpfField = $('#agenda-cpf');
  const postalCodeField = $('#agenda-postal-code');
  const stateField = $('#agenda-state');
  const previousMonthButton = $('#agenda-prev');
  const nextMonthButton = $('#agenda-next');

  const pad = (n) => String(n).padStart(2, '0');
  const keyFromParts = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const monthKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  const partsInSaoPaulo = (value) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const dayKey = (value) => {
    const p = partsInSaoPaulo(value);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const displayDate = (value, options = { weekday: 'long', day: 'numeric', month: 'long' }) =>
    new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: zone }).format(new Date(value));
  const displayTime = (value) => new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: zone
  }).format(new Date(value));
  const digitsOnly = (value) => String(value || '').replace(/\D/g, '');
  const formatCpf = (value) => {
    const digits = digitsOnly(value).slice(0, 11);
    if (digits.length > 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
    if (digits.length > 6) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
    if (digits.length > 3) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
    return digits;
  };
  const formatPostalCode = (value) => {
    const digits = digitsOnly(value).slice(0, 8);
    return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
  };
  function isValidCpf(value) {
    const cpf = digitsOnly(value);
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    const checkDigit = (length) => {
      let sum = 0;
      for (let index = 0; index < length; index += 1) sum += Number(cpf[index]) * (length + 1 - index);
      const digit = (sum * 10) % 11;
      return digit === 10 ? 0 : digit;
    };
    return checkDigit(9) === Number(cpf[9]) && checkDigit(10) === Number(cpf[10]);
  }
  const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const todayKey = dayKey(new Date());

  function updateNotice(text, mode = 'normal') {
    notice.dataset.mode = mode;
    notice.textContent = text;
  }

  function makeDemoSlots(date) {
    const y = date.getFullYear();
    const m = date.getMonth();
    const count = new Date(y, m + 1, 0).getDate();
    const slots = [];
    for (let day = 1; day <= count; day += 1) {
      const d = new Date(y, m, day, 12);
      const key = keyFromParts(y, m + 1, day);
      if (key < todayKey || d.getDay() === 0) continue;
      if ((day + m) % 3 === 0) continue;
      const times = d.getDay() === 6 ? [['09:00', 1]] : [['09:00', 1], ['14:00', 2]];
      for (const [time, doctorNumber] of times) {
        slots.push({
          id: `DEMO-${key}-${time.replace(':', '')}-${doctorNumber}`,
          doctorId: `demo-doctor-${doctorNumber}`,
          doctorName: `Doutora ${doctorNumber} · exemplo`,
          startsAt: `${key}T${time}:00-03:00`,
          endsAt: `${key}T${time === '09:00' ? '09:50' : '14:50'}:00-03:00`,
          status: 'available',
          isDemo: true
        });
      }
    }
    return slots;
  }

  async function fetchAvailability(date) {
    const id = ++state.requestId;
    state.loading = true;
    state.selectedSlot = null;
    state.slots = [];
    state.selectedDay = '';
    statusLine.textContent = '';
    if (demo) {
      state.slots = makeDemoSlots(date);
      state.loading = false;
      updateNotice('Prévia demonstrativa: nomes e horários são exemplos. Nenhum dado é enviado, nenhum horário é reservado e nenhuma cobrança é feita.', 'demo');
    } else if (!apiBase) {
      updateNotice('A agenda está sendo configurada. Não mostramos horários fictícios nem coletamos dados sem uma disponibilidade real.');
      state.loading = false;
    } else {
      updateNotice(privacyUrl
        ? 'Consultando a disponibilidade da equipe…'
        : 'A disponibilidade foi preparada, mas é preciso publicar o aviso de privacidade antes de liberar o envio de dados.');
      try {
        const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
        const last = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
        const from = keyFromParts(first.getFullYear(), first.getMonth() + 1, first.getDate());
        const to = keyFromParts(last.getFullYear(), last.getMonth() + 1, last.getDate());
        const response = await fetch(`${apiBase}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
          method: 'GET', headers: {
            Accept: 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`
          }, cache: 'no-store'
        });
        if (!response.ok) throw new Error('Não foi possível consultar a agenda.');
        const data = await response.json();
        if (id !== state.requestId) return;
        state.slots = Array.isArray(data.slots)
          ? data.slots.filter((slot) => slot && slot.status === 'available' && slot.id && slot.startsAt && slot.doctorName)
          : [];
        if (!privacyUrl) {
          updateNotice('Os horários foram carregados. O envio de dados continua bloqueado até que o aviso de privacidade seja publicado.');
        } else if (!state.slots.length) {
          updateNotice('A agenda recorrente começa em 17/11/2026. Se não houver vagas neste mês, navegue para outro mês ou fale com a clínica.');
        } else {
          updateNotice('Selecione um horário realmente disponível. A vaga fica pendente até o pagamento Pix ser conferido pela clínica.');
        }
      } catch (error) {
        if (id !== state.requestId) return;
        updateNotice(`${error.message || 'Não conseguimos carregar a agenda.'} Tente novamente mais tarde ou entre em contato com a clínica.`);
        state.slots = [];
      } finally {
        if (id === state.requestId) state.loading = false;
      }
    }
    const nearest = state.slots.map((slot) => dayKey(slot.startsAt)).sort()[0] || '';
    if (nearest) state.selectedDay = nearest;
    renderCalendar();
    renderSlots();
    updateSummary();
    updateSubmitState();
  }

  function renderCalendar() {
    const year = state.month.getFullYear();
    const month = state.month.getMonth();
    monthLabel.textContent = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(state.month);
    daysGrid.replaceChildren();
    const offset = new Date(year, month, 1).getDay();
    const total = new Date(year, month + 1, 0).getDate();
    for (let blank = 0; blank < offset; blank += 1) {
      const spacer = document.createElement('span');
      spacer.setAttribute('aria-hidden', 'true');
      daysGrid.append(spacer);
    }
    const availableDays = new Set(state.slots.map((slot) => dayKey(slot.startsAt)));
    for (let number = 1; number <= total; number += 1) {
      const key = keyFromParts(year, month + 1, number);
      const date = new Date(year, month, number, 12);
      const hasSlots = availableDays.has(key);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'online-agenda__day';
      button.textContent = String(number);
      button.setAttribute('aria-label', `${displayDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}${hasSlots ? ', há horários disponíveis' : ', sem horários disponíveis'}`);
      button.setAttribute('aria-pressed', String(state.selectedDay === key));
      if (hasSlots) button.classList.add('has-slots');
      button.disabled = key < todayKey || !hasSlots || state.loading;
      button.addEventListener('click', () => {
        state.selectedDay = key;
        state.selectedSlot = null;
        renderCalendar();
        renderSlots();
        updateSummary();
        updateSubmitState();
      });
      daysGrid.append(button);
    }
    const current = new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
    const lastAllowed = new Date(current.getFullYear(), current.getMonth() + 2, 1, 12);
    previousMonthButton.disabled = state.loading || state.month <= current;
    nextMonthButton.disabled = state.loading || state.month >= lastAllowed;
  }

  function renderSlots() {
    slotsHost.replaceChildren();
    const title = document.createElement('p');
    title.className = 'online-agenda__slots-title';
    title.textContent = state.selectedDay
      ? `Horários disponíveis em ${new Intl.DateTimeFormat('pt-BR', { timeZone: zone, day: 'numeric', month: 'long' }).format(new Date(`${state.selectedDay}T12:00:00-03:00`))}`
      : 'Escolha uma data marcada para ver os horários e a doutora responsável.';
    slotsHost.append(title);

    const matches = state.slots.filter((slot) => dayKey(slot.startsAt) === state.selectedDay);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'online-agenda__empty';
      empty.textContent = demo
        ? 'Não há horários de exemplo neste dia. Escolha outra data com um ponto vinho.'
        : 'Nenhum horário disponível para mostrar neste momento.';
      slotsHost.append(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'online-agenda__slot-list';
    for (const slot of matches.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'online-agenda__slot';
      button.setAttribute('aria-pressed', String(state.selectedSlot?.id === slot.id));
      button.setAttribute('aria-label', `${displayTime(slot.startsAt)}, ${slot.doctorName}${slot.isDemo ? ', exemplo' : ''}`);
      const time = document.createElement('time');
      time.dateTime = slot.startsAt;
      time.textContent = displayTime(slot.startsAt);
      const doctor = document.createElement('span');
      doctor.textContent = slot.doctorName;
      button.append(time, doctor);
      button.addEventListener('click', () => {
        state.selectedSlot = slot;
        renderSlots();
        updateSummary();
        updateSubmitState();
      });
      list.append(button);
    }
    slotsHost.append(list);
  }

  function updateSummary() {
    if (!state.selectedSlot) {
      summaryTitle.textContent = 'Sua consulta começa aqui';
      summaryDetail.textContent = 'Escolha um horário para ver a doutora, a data e o valor da reserva.';
      return;
    }
    summaryTitle.textContent = displayDate(state.selectedSlot.startsAt);
    summaryDetail.textContent = `${displayTime(state.selectedSlot.startsAt)} · ${state.selectedSlot.doctorName}`;
  }

  function updateSubmitState() {
    const privacyAccepted = privacyCheck.checked;
    const fieldsReady = bookingForm.checkValidity();
    submitButton.disabled = !liveReady || !state.selectedSlot || !privacyAccepted || !fieldsReady;
    for (const field of patientFields) field.disabled = !liveReady;
    privacyCheck.disabled = !liveReady;
    if (privacyUrl) {
      privacyLink.href = privacyUrl;
      privacyLink.hidden = false;
    } else {
      privacyLink.hidden = true;
    }
  }

  async function apiJson(endpoint, options = {}) {
      const response = await fetch(`${apiBase}/${endpoint}`, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || 'Não foi possível concluir esta etapa.');
    return result;
  }

  function showPixInstructions(result, selectedSlot, patientName) {
    const doctorName = String(result.doctorName || selectedSlot.doctorName || '');
    const qrImage = /j[eé]ssica/i.test(doctorName)
      ? './images/pix-jessica.png'
      : /mariana/i.test(doctorName) ? './images/pix-mariana.png' : '';
    if (!qrImage || Number(result.amountCents) !== 12500) {
      paymentStatus.textContent = 'A reserva foi criada, mas não conseguimos identificar com segurança o QR da profissional. Não pague por outro código; fale com a clínica pelo WhatsApp.';
      paymentPanel.hidden = false;
      paymentQr.hidden = true;
      return;
    }
    const appointmentTime = result.startsAt || selectedSlot.startsAt;
    const appointmentDate = displayDate(appointmentTime);
    const appointmentHour = displayTime(appointmentTime);
    const reference = String(result.bookingId).slice(0, 8).toUpperCase();
    const firstName = String(patientName || '').trim().split(/\s+/)[0] || 'Olá';
    paymentQr.src = qrImage;
    paymentQr.alt = `QR Code Pix de ${doctorName} para o sinal de R$ 125,00`;
    paymentQr.hidden = false;
    paymentDetail.textContent = `${doctorName} · ${appointmentDate}, às ${appointmentHour} · código ${reference}. A vaga fica pendente enquanto aguardamos o pagamento.`;
    const message = `Olá, Base Dermatologia! Enviei o Pix de R$ 125,00 para solicitar minha consulta.\nNome: ${firstName}\nProfissional: ${doctorName}\nData e horário: ${appointmentDate}, às ${appointmentHour}\nCódigo: ${reference}\nVou anexar o comprovante.`;
    whatsappLink.href = `https://wa.me/${result.whatsappNumber || '5511927420834'}?text=${encodeURIComponent(message)}`;
    paymentStatus.textContent = `Aguardando o pagamento e a conferência da clínica. A vaga expira às ${displayTime(result.holdExpiresAt)} se o pagamento ainda não tiver sido enviado.`;
    paymentPanel.hidden = false;
  }

  bookingForm.addEventListener('input', updateSubmitState);
  privacyCheck.addEventListener('change', updateSubmitState);
  cpfField.addEventListener('input', () => {
    cpfField.value = formatCpf(cpfField.value);
    const cpf = digitsOnly(cpfField.value);
    cpfField.setCustomValidity(cpf.length === 11 && !isValidCpf(cpf) ? 'Informe um CPF válido.' : '');
    updateSubmitState();
  });
  postalCodeField.addEventListener('input', () => {
    postalCodeField.value = formatPostalCode(postalCodeField.value);
    updateSubmitState();
  });
  stateField.addEventListener('input', () => {
    stateField.value = stateField.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 2);
    updateSubmitState();
  });
  previousMonthButton.addEventListener('click', () => {
    if (previousMonthButton.disabled) return;
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1, 12);
    fetchAvailability(state.month);
  });
  nextMonthButton.addEventListener('click', () => {
    if (nextMonthButton.disabled) return;
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1, 12);
    fetchAvailability(state.month);
  });
  bookingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    updateSubmitState();
    if (!liveReady || !state.selectedSlot || submitButton.disabled) return;
    submitButton.disabled = true;
    statusLine.textContent = 'Criando sua solicitação pendente…';
    const formData = new FormData(bookingForm);
    const selectedSlot = state.selectedSlot;
    try {
      const result = await apiJson('book-appointment', {
        method: 'POST',
        body: {
          slotId: selectedSlot.id,
          fullName: String(formData.get('fullName') || '').trim(),
          phone: String(formData.get('phone') || '').trim(),
          email: String(formData.get('email') || '').trim(),
          cpf: digitsOnly(formData.get('cpf')),
          address: {
            line: String(formData.get('addressLine') || '').trim(),
            number: String(formData.get('addressNumber') || '').trim(),
            complement: String(formData.get('addressComplement') || '').trim(),
            neighborhood: String(formData.get('addressNeighborhood') || '').trim(),
            city: String(formData.get('addressCity') || '').trim(),
            state: String(formData.get('addressState') || '').trim().toUpperCase(),
            postalCode: digitsOnly(formData.get('addressPostalCode'))
          },
          acceptedPrivacy: privacyCheck.checked,
          privacyVersion,
          website: String(formData.get('website') || '')
        }
      });
      if (!result.bookingId || result.status !== 'pending_payment' || result.paymentRequired !== true) {
        throw new Error('A solicitação não foi criada. Atualize os horários antes de tentar novamente.');
      }
      const patientName = String(formData.get('fullName') || '').trim();
      paymentPanel.dataset.bookingId = String(result.bookingId);
      paymentPanel.dataset.accessToken = String(result.accessToken || '');
      bookingForm.reset();
      bookingForm.hidden = true;
      await fetchAvailability(state.month);
      showPixInstructions(result, selectedSlot, patientName);
      statusLine.textContent = 'Solicitação criada. O horário ainda não está confirmado.';
    } catch (error) {
      statusLine.textContent = error.message || 'Não foi possível iniciar a reserva. Atualize os horários e tente de novo.';
    } finally {
      updateSubmitState();
    }
  });

  proofSentButton.addEventListener('click', async () => {
    const bookingId = paymentPanel.dataset.bookingId || '';
    const accessToken = paymentPanel.dataset.accessToken || '';
    if (!bookingId || !accessToken || proofSentButton.disabled) return;
    proofSentButton.disabled = true;
    paymentStatus.textContent = 'Registrando o aviso de envio…';
    try {
      const result = await apiJson('mark-proof-sent', {
        method: 'POST',
        body: { bookingId, accessToken }
      });
      paymentStatus.textContent = result.message || 'Envio registrado. A consulta só será confirmada depois da conferência do Pix pela clínica.';
      proofSentButton.textContent = 'Comprovante marcado como enviado';
    } catch (error) {
      paymentStatus.textContent = error.message || 'Não conseguimos atualizar o aviso de envio. Fale com a clínica pelo WhatsApp.';
      proofSentButton.disabled = false;
    }
  });

  if (demo) document.querySelector('.online-agenda').classList.add('online-agenda--demo');
  fetchAvailability(state.month);
})();
