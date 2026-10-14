/* Configure somente após implantar e testar a API de agenda.
 * Nunca coloque aqui: chave secreta do Asaas, service_role do Supabase,
 * token de webhook ou credenciais de email/WhatsApp.
 */
window.BASE_AGENDA_CONFIG = Object.freeze({
  apiBaseUrl: "",     // Ex.: URL pública das Supabase Edge Functions
  privacyUrl: "",     // Aviso de privacidade publicado pela clínica
  privacyVersion: ""  // Versão do aviso que a paciente aceitou
});
