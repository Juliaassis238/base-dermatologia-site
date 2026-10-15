# Agenda da Base Dermatologia — Supabase e InfinitePay

## Estado atual

- O site permanece no GitHub Pages e consulta a agenda por uma Supabase Edge Function.
- Projeto Supabase: `base-dermatologia-agenda`, região `sa-east-1` (São Paulo). A cotação apresentada na criação foi **US$ 0/mês**.
- A migração `supabase/migrations/001_agenda.sql` cria profissionais, horários, reservas, tabelas reservadas para pagamentos InfinitePay e uma operação transacional contra dupla reserva.
- A função `agenda` está publicada com verificação JWT. O navegador usa somente a chave pública `anon`; `service_role` não fica no repositório nem no site.
- **Modo temporário atual:** a reserva é confirmada pelo servidor sem pagamento (`payment_required=false`, `payment_status=not_required`). Não há cobrança Pix, QR Code nem link de pagamento.
- As profissionais já apresentadas no site foram cadastradas. **Nenhum horário fictício foi criado**; a tabela de disponibilidades começa vazia. Portanto, o calendário informa que não há horários até a clínica cadastrar os períodos reais.
- A página `privacidade.html` explica quais dados de contato o formulário usa. O aviso é um texto inicial baseado nas informações públicas do site e deve ser revisado pela clínica antes de divulgar a coleta de dados.
- Ainda não há notificações automáticas por e-mail/WhatsApp nem painel de clínica separado. As reservas ficam registradas no banco Supabase; o acesso ao painel do projeto exige login.

## Fluxo implementado sem pagamento

1. `GET /availability?from=AAAA-MM-DD&to=AAAA-MM-DD` lista somente horários futuros, ativos e realmente disponíveis, sem expor dados de pacientes.
2. `POST /book-appointment` recebe horário, nome, telefone, e-mail e versão do aviso de privacidade. Valida os campos no servidor.
3. A função `book_appointment_without_payment` bloqueia a linha do horário e cria a reserva confirmada na mesma transação. Duas pessoas não conseguem confirmar a mesma vaga.
4. O site mostra a confirmação e o código curto da reserva. A chave de serviço do Supabase nunca é enviada ao navegador.
5. `POST /booking-status` permite consultar o estado mediante identificador e token aleatório; o banco guarda apenas o hash desse token.

Rotas públicas disponíveis na Edge Function:

- `GET https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/availability?from=AAAA-MM-DD&to=AAAA-MM-DD`
- `POST https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/book-appointment`
- `POST https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/booking-status`
- `GET https://cahumbjzkssgjqwvwakt.supabase.co/functions/v1/agenda/health`

## O que falta para abrir horários reais

A clínica precisa fornecer e confirmar:

- quais dias e horários cada dermatologista atende;
- duração de cada consulta e intervalo entre pacientes;
- até quantos dias à frente a agenda deve abrir;
- feriados, férias e bloqueios já conhecidos;
- se a reserva sem pagamento deve continuar sendo confirmada imediatamente;
- e-mail da clínica/das profissionais se quiserem receber notificações (um serviço de envio também precisará ser configurado).

Depois disso, os horários reais podem ser cadastrados em `availability_slots`. Sem esses dados, a agenda não aceita horários imaginários nem cria reservas.

O projeto pode ser acessado no [painel Supabase da agenda](https://supabase.com/dashboard/project/cahumbjzkssgjqwvwakt). Reservas ficam na tabela `public.appointments`; disponibilidade fica em `public.availability_slots`.

## Integração futura com InfinitePay

O banco já reserva os campos para a etapa futura, mas **a integração de pagamento ainda não está conectada**. Quando a clínica ativar o Checkout Integrado da InfinitePay, o fluxo deve mudar para:

1. O servidor cria um pedido/checkout **individual para cada reserva** e devolve a URL de pagamento da InfinitePay; não reutilizar um link manual comum entre pacientes.
2. O horário fica temporariamente reservado enquanto o pagamento está pendente.
3. Um webhook validado no servidor verifica identificador da reserva, valor e resultado do pagamento, tratando notificações repetidas de forma idempotente.
4. Somente após confirmação verificada pelo servidor o estado passa a `confirmed`; em falha/expiração, a vaga é liberada. A página de retorno do checkout ou um comprovante enviado pela cliente não confirmam pagamento.

As tabelas `payments` e `payment_webhook_events` já foram criadas para guardar os identificadores e eventos necessários. Não há chaves ou credenciais da InfinitePay configuradas. O site hoje informa R$ 125,00 de sinal e R$ 125,00 no dia; confirmar esse valor antes de implementar a cobrança.

## Dados e acesso

O formulário coleta somente nome, telefone, e-mail e horário escolhido — não deve receber sintomas, fotos ou histórico médico. RLS está habilitada nas tabelas e não há leitura direta pelo navegador. O serviço público passa pela Edge Function e só devolve os horários abertos. O aviso de privacidade precisa ser revisto pela clínica, inclusive sobre responsável pelo tratamento, contato, retenção e pedidos das titulares.
