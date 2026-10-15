# Agenda da Base Dermatologia — Supabase e InfinitePay

## Estado atual

- O site permanece no GitHub Pages e consulta a agenda por uma Supabase Edge Function.
- Projeto Supabase: `base-dermatologia-agenda`, região `sa-east-1` (São Paulo). A cotação apresentada na criação foi **US$ 0/mês**.
- A função `agenda` exige JWT. O site usa somente a chave pública `anon`; a chave `service_role` fica no servidor.
- **Disponibilidade recorrente configurada:** toda terça-feira, a partir de **17/11/2026**, Jéssica Saab das **09:00 às 13:00** e Mariana Gil Furlanetti das **14:00 às 18:00**, em blocos de **30 minutos**, no fuso de São Paulo. O período não tem data final definida.
- Os horários de cada mês são materializados de forma idempotente quando o calendário consulta aquele mês. O site permite navegar pelo mês atual e os dois seguintes.
- **Modo atual sem pagamento:** a reserva é confirmada imediatamente pelo servidor (`payment_required=false`, `payment_status=not_required`). Não há cobrança Pix, QR Code, checkout ou webhook InfinitePay.
- Nenhuma reserva de paciente foi criada durante a configuração. O banco de appointments estava vazio antes da adição dos novos campos fiscais.
- Ainda não há notificações automáticas por e-mail/WhatsApp nem painel administrativo separado. As reservas ficam na tabela `public.appointments` e podem ser consultadas no painel Supabase por uma pessoa autorizada.

## Fluxo da agenda

1. `GET /availability?from=AAAA-MM-DD&to=AAAA-MM-DD` gera as vagas da regra semanal para o mês consultado e devolve apenas horários futuros e disponíveis.
2. `POST /book-appointment` recebe horário, nome, telefone, e-mail, CPF, endereço completo e a versão do aviso de privacidade. A função valida CPF/CEP/endereço no servidor.
3. `book_appointment_without_payment` trava a linha do horário e grava a reserva confirmada sem cobrança na mesma transação. Duas pessoas não conseguem confirmar a mesma vaga.
4. O site mostra a confirmação e um código curto. A chave de serviço do Supabase nunca é enviada ao navegador.
5. `POST /booking-status` permite consultar estado mediante identificador e token aleatório; apenas o hash do token fica no banco.

Rotas públicas disponíveis:

- `GET https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/availability?from=AAAA-MM-DD&to=AAAA-MM-DD`
- `POST https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/book-appointment`
- `POST https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/booking-status`
- `GET https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/health`

## Dados para nota fiscal

O formulário pede CPF, CEP, logradouro, número, bairro, cidade e UF; complemento é opcional. CPF e endereço são gravados em colunas próprias na tabela `appointments` para a clínica emitir a nota fiscal. O navegador não acessa essa tabela diretamente; somente a função do servidor grava ou consulta os dados.

A página pública de privacidade explica essa finalidade. A clínica deve confirmar se a identificação do responsável pelo tratamento, o canal para pedidos das titulares e os prazos de retenção estão corretos para sua operação. O formulário não deve receber sintomas, fotos, diagnóstico ou histórico médico.

## Administração e ajustes

O projeto pode ser acessado no [painel Supabase da agenda](https://supabase.com/dashboard/project/cahumbjzkssgjqwvwakt). As reservas ficam em `public.appointments`; a disponibilidade gerada, em `public.availability_slots`; as regras semanais, em `public.doctor_weekly_rules`.

Para alterar horários recorrentes, ajuste a regra correspondente e revise vagas futuras já materializadas que ainda estejam disponíveis. A rotina gera horários de forma contínua ao consultar cada mês; não há término de regra configurado.

## Integração futura com InfinitePay

O banco já reserva as tabelas `payments` e `payment_webhook_events`, mas **a integração de pagamento ainda não está conectada**. Quando a clínica ativar o Checkout Integrado da InfinitePay, o fluxo deve mudar para:

1. O servidor cria um checkout **individual por reserva** e devolve a URL de pagamento; não reutilizar um link manual comum entre pacientes.
2. O horário fica temporariamente reservado enquanto o pagamento está pendente.
3. Um webhook validado no servidor confere identificador da reserva e valor e processa eventos repetidos de forma idempotente.
4. Só após confirmação verificada pelo servidor a consulta passa a confirmada; em falha/expiração, a vaga é liberada. A tela de retorno do checkout ou um comprovante não confirmam pagamento.

Não há chaves ou credenciais InfinitePay configuradas. O site informa R$ 125,00 de sinal e R$ 125,00 no dia; confirmar esse valor antes de implementar cobrança.

## Segurança e operação

RLS está habilitada nas tabelas e não existem políticas públicas de leitura/gravação: isso é intencional para negar acesso direto pelo navegador. O serviço público passa pela Edge Function, que devolve apenas os horários abertos. Dados de pacientes não são retornados pela API pública de disponibilidade. O sistema não envia avisos automáticos neste momento; a clínica precisa consultar o painel Supabase até configurar notificações.
