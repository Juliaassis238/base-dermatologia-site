# Base Dermatologia — site institucional

Site estático, responsivo e acessível, feito em HTML, CSS e JavaScript. Publicado pelo GitHub Pages; a agenda usa um projeto Supabase para armazenar horários e reservas.

## Contato

WhatsApp da clínica: [+55 11 92742-0834](https://wa.me/5511927420834).

## Agenda online

A agenda está configurada para as terças-feiras a partir de 17/11/2026: Jéssica Saab, das 9h às 13h; Mariana Gil Furlanetti, das 14h às 18h. Cada consulta dura 30 minutos. A reserva nesta fase é confirmada sem pagamento; InfinitePay ainda não está conectada.

O formulário pede nome, telefone, e-mail, CPF e endereço completo para a emissão da nota fiscal. O aviso de privacidade foi atualizado para explicar esse uso. O calendário gera os horários do mês consultado e permite navegar pelo mês atual e os dois seguintes. Ainda não há notificações automáticas para a clínica; reservas ficam no painel Supabase.

Consulte [INTEGRACAO-AGENDA.md](./INTEGRACAO-AGENDA.md) para detalhes e próximos passos.

## Visualização local

Na pasta do projeto, inicie um servidor local:

```bash
python3 -m http.server 8000
```

Depois acesse <http://localhost:8000>.

As fontes tipográficas são carregadas do Google Fonts e o mapa usa o Google Maps. O site não precisa de etapa de build.
