# Agenda da Base Dermatologia — Pix manual e painel administrativo

## Configuração do projeto

O site é estático, publicado pelo GitHub Pages, e usa uma Edge Function chamada `agenda` no projeto Supabase `cahumbjzkssgjqwvwakt`. O navegador usa somente a chave pública anon. A chave `service_role` permanece no servidor e não deve ser copiada para HTML, JavaScript ou configuração pública.

A disponibilidade recorrente é às terças-feiras a partir de 17/11/2026, no fuso `America/Sao_Paulo`: Jéssica Saab atende das 09:00 às 13:00 e Mariana Gil Furlanetti das 14:00 às 18:00, em blocos de 30 minutos. A vaga já está associada à profissional no banco. O painel mostra a profissional que pertence ao horário escolhido; não decide a doutora pelo momento em que o paciente pagou. Uma remarcação transfere a reserva para a profissional do novo horário.

O sinal para solicitar a reserva é R$ 125,00 via Pix. O valor total da consulta informado no site é R$ 250,00. Os QR Codes vieram da clínica e não incluem valor fixo; o paciente deve digitar R$ 125,00 ao fazer o Pix. O site apenas exibe o código: o pagamento ocorre diretamente no aplicativo bancário, e o comprovante é enviado pelo paciente à clínica no WhatsApp (11) 92742-0834. O site não recebe arquivos de comprovante e não verifica pagamentos automaticamente.

## Fluxo do paciente e estados

1. `GET /availability?from=AAAA-MM-DD&to=AAAA-MM-DD` materializa horários recorrentes do período, expira vagas cujo prazo já terminou e devolve apenas horários futuros, livres e de profissionais ativas.
2. `POST /book-appointment` valida horário, nome, contato, CPF, endereço e aceite do aviso de privacidade. O banco cria a reserva como `pending_payment` e segura a vaga por duas horas, em uma transação atômica. Duas pessoas não podem reservar o mesmo horário.
3. A resposta contém apenas o identificador, um token aleatório de uso limitado, o nome da profissional, o valor de R$ 125,00 e a data de expiração. O token de acesso à reserva só é armazenado no banco como hash.
4. O site escolhe o QR local da Jéssica ou da Mariana segundo a profissional associada à vaga. O paciente abre o WhatsApp da clínica, envia o comprovante e depois pode marcar “Já enviei o comprovante”. Isso muda o estado para `payment_review`; não comprova crédito na conta e não confirma a consulta.
5. Se o Pix não for recebido dentro das duas horas, uma chamada posterior à agenda marca a reserva como `expired` e libera a vaga. Uma reserva com comprovante informado fica aguardando verificação e não expira automaticamente.
6. Uma doutora entra no painel e confere o crédito diretamente na conta Pix. Só então usa “Conferir Pix e liberar”; o estado passa para `confirmed`, o pagamento fica registrado como `received` e a vaga passa para `booked`.
7. A equipe pode cancelar uma marcação ou editar os dados do paciente e remarcar para uma vaga livre. Cancelar libera o horário. O sistema não processa reembolso automaticamente; eventual reembolso de Pix recebido deve ser feito à parte.

## Painel administrativo

O painel está em `admin.html` e autentica pelo Supabase Auth com e-mail e senha. A conta autorizada `contato@basedermatologia.com.br` foi criada pela clínica no painel Supabase com confirmação automática; não se envia convite, magic link ou outro e-mail de acesso, e não é necessário configurar SMTP ou URL de retorno para esse login.

As doutoras usam a mesma conta e a mesma senha. A opção “Alterar senha compartilhada” pede a senha atual, exige uma nova senha com pelo menos 12 caracteres e atualiza diretamente a credencial no Supabase Auth; em seguida, o painel testa o novo login e renova a sessão antes de informar sucesso. A alteração vale para ambas. Se a validação da nova sessão falhar, o painel pede novo login com a senha atualizada. Se a senha for esquecida, o responsável pelo projeto Supabase precisa redefini-la manualmente. Como o login é compartilhado, o histórico administrativo fica associado ao e-mail da clínica e não identifica qual doutora fez cada alteração.

A API valida o JWT da sessão e só aceita esse endereço para operações administrativas. A interface mostra uma agenda por data, horário, profissional e estado, além de uma lista paginada com filtro por situação e busca por nome, e-mail, telefone ou código. O editor inclui nome, e-mail, telefone, CPF, endereço e remarcação.

A tabela de auditoria `public.appointment_admin_audit` registra as operações administrativas sob o mesmo e-mail da clínica, os campos alterados e os horários anterior e novo. O acesso direto às tabelas permanece bloqueado para o navegador; a API administrativa passa pela Edge Function e pelos RPCs protegidos. CPF e endereço não são copiados para os logs de auditoria.

## Rotas da Edge Function

Todas as chamadas exigem a chave pública anon no header `apikey`. Os endpoints administrativos também exigem `Authorization: Bearer <access_token>` da sessão Supabase autenticada pelo e-mail autorizado.

Rotas públicas:

- `GET /availability?from=AAAA-MM-DD&to=AAAA-MM-DD`
- `POST /book-appointment`
- `POST /mark-proof-sent`
- `POST /booking-status`
- `GET /health`

Rotas administrativas:

- `GET /admin-appointments?status=<estado>&page=<n>&q=<busca>`
- `POST /admin-appointment` com `action: "approve"`, `"cancel"` ou `"edit"`

RPCs do banco usados pelo backend:

- `expire_pending_pix_appointments`
- `book_appointment_for_pix`
- `mark_pix_proof_sent`
- `admin_search_appointments`
- `admin_approve_pix_appointment`
- `admin_cancel_appointment`
- `admin_update_appointment`

As reservas são armazenadas em `public.appointments`; horários em `public.availability_slots`; regras semanais em `public.doctor_weekly_rules`; histórico administrativo em `public.appointment_admin_audit`. O schema mantém RLS ativo, sem políticas de acesso público às tabelas de pacientes.

## Publicação

O site continua servível sem etapa de build. Para publicar, envie as alterações do repositório `juliaassis238/base-dermatologia-site` para a branch padrão e aguarde o GitHub Pages concluir a atualização. A migração `supabase/migrations/005_pix_admin_workflow.sql` deve ser aplicada antes de liberar a nova Edge Function `supabase/functions/agenda/index.ts`; o JavaScript local depende dos novos endpoints e deve ser publicado em seguida.
