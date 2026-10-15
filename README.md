# Base Dermatologia — site institucional

Site estático, responsivo e acessível, feito em HTML, CSS e JavaScript. O site é publicado pelo GitHub Pages; a agenda usa um projeto Supabase separado para armazenar disponibilidade e reservas.

## Contato

WhatsApp da clínica: [+55 11 92742-0834](https://wa.me/5511927420834).

## Agenda online

A Edge Function Supabase `agenda` consulta horários e grava reservas com proteção contra dupla marcação. A fase atual confirma a reserva **sem pagamento**. O banco está preparado para a integração futura com Checkout/InfinitePay, mas nenhum pagamento é processado ainda.

A agenda não mostra horários até que a clínica cadastre dias, horários, duração e intervalos reais de atendimento. Não foram criadas disponibilidades ou reservas fictícias. Consulte [INTEGRACAO-AGENDA.md](./INTEGRACAO-AGENDA.md) para o estado e os passos de configuração. O aviso público inicial está em [privacidade.html](./privacidade.html) e deve ser revisto pela clínica.

## Visualização local

Na pasta do projeto, inicie um servidor local:

```bash
python3 -m http.server 8000
```

Depois acesse <http://localhost:8000>.

## Antes de abrir a agenda ao público

- Confirmar a disponibilidade real de cada profissional.
- Revisar o aviso de privacidade e confirmar o responsável e o canal de contato.
- Definir se a reserva sem pagamento continuará sendo confirmada imediatamente.
- Configurar notificações se a clínica quiser recebê-las por e-mail ou WhatsApp.
- Antes de ativar InfinitePay, confirmar o valor do sinal e testar checkout e webhook.

As fontes tipográficas são carregadas do Google Fonts e o mapa usa o Google Maps. O site não precisa de etapa de build.
