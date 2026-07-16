# Hunger Games da Live — v5.7.0

Versão corrigida para gerar **somente um evento por vez** e narrar na **página pública**.

## Correções principais

- Cada clique em **Próximo** gera exatamente 1 evento.
- Cada comando `!hg proximo` gera exatamente 1 evento.
- O modo automático só cria o próximo evento depois que a página pública termina a exibição/narração, ou depois do tempo de segurança caso ela esteja fechada.
- A narração toca apenas na página pública; os controles continuam somente no painel administrativo.
- Voz, velocidade e tempo mínimo ficam salvos no banco e são enviados para a página pública.
- Se o navegador bloquear reprodução automática, aparece somente um botão discreto para liberar o áudio uma vez.
- Cada participante é usado uma vez por fase antes de avançar para Dia/Noite/Banquete.
- O último evento e o vencedor não criam dois cartões ao mesmo tempo.
- Eventos e histórias já salvos não são apagados.

## Deploy

1. Substitua os arquivos na raiz do repositório.
2. No Render, use **Manual Deploy → Clear build cache & deploy**.
3. Confira `/version`. Deve mostrar `5.7.0`.
4. Abra a página pública antes de iniciar a partida.
5. Se aparecer **Clique uma vez para liberar a narração**, clique uma vez. Isso é uma exigência do navegador para áudio automático.
