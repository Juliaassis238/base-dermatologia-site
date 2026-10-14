# Agenda da Base Dermatologia — ativação e integração

A seção **Agenda on-line** já está incorporada ao site. Como ele é publicado pelo GitHub Pages, hoje ele serve arquivos estáticos: sozinho, não guarda reservas com segurança, não trava horários e não recebe notificações de pagamento. A interface pública deixa isso explícito e não exibe horários fictícios. A prévia com dados de exemplo aparece apenas quando se acrescenta `?demo=1` ao endereço; não envia formulário, reserva vaga nem cria cobrança.

O banco de dados, o servidor de agendamento e o webhook precisam ser configurados antes que uma paciente possa pagar e receber confirmação real. O HTML inclui o contrato de integração da agenda, e `supabase/migrations/001_agenda.sql` é **um esquema inicial**, não uma configuração pronta para produção.

## Arquitetura recomendada

- **Site:** GitHub Pages, mantendo os arquivos públicos já hospedados.
- **Banco e funções de servidor:** Supabase Postgres + Edge Functions.
- **Pix:** cobrança individual com QR Code dinâmico pelo Asaas.
- **E-mail:** uma função transacional no servidor envia a confirmação à paciente e à doutora associada à vaga. WhatsApp exige uma integração oficial à parte e credenciais da clínica.

O Asaas permite criar uma cobrança Pix e recuperar o QR Code dinâmico por API [1]. Para confirmar a reserva, o servidor deve receber o webhook: o evento `PAYMENT_RECEIVED` indica cobrança recebida e valor disponível; `PAYMENT_CONFIRMED` significa que o pagamento foi efetuado, mas o saldo ainda pode não estar liberado [2]. Não marque a consulta como paga com base na tela de retorno, em captura de tela ou em dados enviados pelo navegador.

## Etapas de ativação

1. **Criar os acessos da clínica.** Crie um projeto Supabase e uma conta Asaas de titularidade da clínica. Ative primeiro o ambiente de testes do Asaas. Escolha a região/servidor mais apropriado disponível para os dados da clínica.
2. **Cadastrar dados reais.** Antes de abrir a agenda, é necessário informar os nomes das doutoras, seus e-mails de notificação, dias/horários de atendimento, duração da consulta, intervalo entre pacientes, feriados e regras para cancelamento. O banco desta base não contém nomes nem horários inventados.
3. **Criar as tabelas.** Revise e aplique `supabase/migrations/001_agenda.sql` no projeto Supabase. Essa primeira estrutura guarda profissionais, horários reais, reservas temporárias, cobranças e eventos mínimos de webhook. Ela também impede horários sobrepostos e usa uma função transacional para que duas pessoas não reservem a mesma vaga.
4. **Implantar as Edge Functions.** Implemente as rotas descritas abaixo no Supabase. Elas devem validar cada campo, verificar a disponibilidade dentro de uma transação, criar uma reserva temporária de 10 minutos e devolver somente os dados necessários ao site. O banco deve permanecer sem acesso direto para visitantes.
5. **Guardar credenciais no servidor.** Adicione a chave privada do Asaas e o segredo de validação do webhook na área **Edge Function Secrets** do Supabase. Nunca coloque segredo do Asaas, `service_role`/chave secreta do Supabase ou credencial de e-mail/WhatsApp em `index.html`, em `scripts/agenda-config.js`, em outro JavaScript público ou no repositório. O Supabase fornece variáveis seguras para as Edge Functions e orienta que chaves de serviço que ignoram RLS nunca sejam usadas no navegador [3] [4].
6. **Apontar o site para as funções.** Em `scripts/agenda-config.js`, preencha `apiBaseUrl` com a URL pública da API implantada e `privacyUrl` com o aviso de privacidade publicado pela clínica. São endereços públicos, não chaves secretas. A interface consumirá as rotas abaixo; o navegador nunca recebe a chave privada do Asaas.
7. **Configurar o webhook do Asaas.** No painel Asaas, cadastre a URL HTTPS da rota `asaas-webhook`, habilite eventos de cobrança e configure o token/segredo correspondente. Valide o segredo, associe a cobrança ao identificador interno da reserva, confira o valor devido e processe cada evento de modo idempotente. Reserve o horário antes de criar a cobrança; se a emissão falhar, libere-o. Se um pagamento chegar depois que a reserva expirar, envie para análise da secretaria em vez de tomar um horário que já pode ter sido reservado por outra pessoa.
8. **Testar antes de abrir ao público.** Teste o QR Code no sandbox do Asaas. Simule pagamentos aprovados, expirados, recusados, webhook repetido, indisponibilidade do banco e duas tentativas simultâneas para a mesma vaga. Confirme que apenas o webhook válido transforma a reserva em confirmada, e que a notificação chega à paciente e à doutora certa. Depois da validação, configure credenciais de produção no Supabase e ative horários reais.

## Contrato de API esperado pelo site

Configure `apiBaseUrl` para o endereço-base que contém estas funções:

- `GET /availability?from=AAAA-MM-DD&to=AAAA-MM-DD` → `{ "slots": [{ "id": "...", "doctorId": "...", "doctorName": "Nome real", "startsAt": "2026-10-20T09:00:00-03:00", "endsAt": "2026-10-20T09:50:00-03:00", "status": "available" }] }`. Só retorne vagas futuras realmente abertas; o nome da doutora vem junto de cada horário.
- `POST /create-pix` recebe `{ "slotId", "fullName", "phone", "email", "acceptedPrivacy", "privacyVersion" }`. No servidor: valida os dados; adquire/trava a vaga em transação; cria cobrança Asaas de **R$ 125,00** vinculada ao identificador interno; obtém QR e código Pix dinâmicos; salva os identificadores de reserva e cobrança. Responde com `{ "bookingId", "accessToken", "expiresAt", "payment": { "qrCodeBase64", "pixCopyPaste" } }`. O token de acesso é aleatório por reserva e guardado no banco apenas como hash.
- `POST /booking-status` recebe `{ "bookingId", "accessToken" }` e devolve apenas o status da reserva e os dados necessários para a paciente consultar seu próprio resultado. Não devolva telefone, e-mail, anotações, outras reservas ou dados médicos.
- `POST /asaas-webhook` valida o segredo do Asaas, registra cada evento uma vez, confirma o valor e a cobrança vinculada e atualiza juntos o pagamento, a reserva e a vaga. Em `PAYMENT_RECEIVED`, confirma a consulta e aciona a notificação ao e-mail cadastrado da paciente e da doutora atribuída.

O valor acima acompanha a política atualmente publicada no site: **R$ 125,00 via Pix para agendar e R$ 125,00 no dia da consulta**. Confirme que essa é a regra comercial vigente antes de ativar cobranças reais.

## Dados, acesso e privacidade

A agenda não solicita sintomas, diagnóstico, convênio, fotos ou histórico médico. Receba apenas nome, telefone/e-mail necessários à reserva e dados estritamente operacionais. O dado referente à saúde é sensível na LGPD, e a lei prevê medidas técnicas e administrativas de segurança desde a concepção até a execução do sistema [5]. Defina com a clínica a base legal, o aviso de privacidade, a retenção e a eliminação, quem pode consultar reservas e o contato para pedidos das titulares; valide o texto e os papéis com assessoria jurídica/encarregado de dados. A RLS do Supabase precisa ficar habilitada e revisada em todas as tabelas expostas; políticas e permissões devem impedir acesso público a nomes e contatos de pacientes [3].

### Referências

[1]: https://docs.asaas.com/docs/cobrancas-via-pix "Asaas — cobranças via Pix e QR Code dinâmico"
[2]: https://docs.asaas.com/docs/webhook-para-cobrancas "Asaas — eventos de webhook para cobranças"
[3]: https://supabase.com/docs/guides/database/postgres/row-level-security "Supabase — Row Level Security"
[4]: https://supabase.com/docs/guides/functions/secrets "Supabase — segredos em Edge Functions"
[5]: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/legislacao/lei-no-13-709-de-14-de-agosto-de-2018 "LGPD — Lei nº 13.709/2018, texto oficial"
