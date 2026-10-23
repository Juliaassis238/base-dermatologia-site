# Base Dermatologia — site institucional

Site estático, responsivo e acessível, feito em HTML, CSS e JavaScript. Publicado pelo GitHub Pages; a agenda usa um projeto Supabase para armazenar horários e reservas.

## Contato

WhatsApp da clínica: [+55 11 92742-0834](https://wa.me/5511927420834).

## Agenda online

A agenda está configurada para as terças-feiras a partir de 17/11/2026: Jéssica Saab, das 9h às 13h; Mariana Gil Furlanetti, das 14h às 18h. Cada consulta dura 30 minutos. O horário marcado determina a profissional responsável; uma remarcação atualiza a profissional automaticamente.

O paciente paga R$ 125,00 via Pix para solicitar a reserva, usando o QR da profissional, e envia o comprovante pelo WhatsApp da clínica. O agendamento fica pendente até que a equipe confira manualmente o recebimento e libere a marcação. Reservas aguardando pagamento expiram após duas horas; as que aguardam conferência permanecem pendentes. O valor total da consulta mostrado no site é R$ 250,00.

O painel da equipe fica em [`admin.html`](./admin.html). Ele usa o e-mail e a senha compartilhados da clínica, sem enviar link de acesso. As duas doutoras usam a mesma conta; alterar a senha no painel muda a credencial para ambas e as ações não são atribuídas individualmente a cada doutora. O painel permite listar, filtrar, aprovar, cancelar, editar dados e remarcar reservas. Também mostra uma agenda por data, hora, profissional e situação do Pix.

O formulário pede nome, telefone, e-mail, CPF e endereço completo para a emissão da nota fiscal. O calendário gera os horários do mês consultado e permite navegar pelo mês atual e os dois seguintes. O comprovante é enviado pela própria paciente via WhatsApp; o site não o recebe nem confirma pagamentos automaticamente.

Consulte [INTEGRACAO-AGENDA.md](./INTEGRACAO-AGENDA.md) para detalhes operacionais.

## Visualização local

Na pasta do projeto, inicie um servidor local:

```bash
python3 -m http.server 8000
```

Depois acesse <http://localhost:8000>.

As fontes tipográficas são carregadas do Google Fonts e o mapa usa o Google Maps. O site não precisa de etapa de build.
