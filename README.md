# Hunger Games da Live — v5.5.0

## Correção do Modo História

Esta versão adiciona um controle real por partida para bloquear os eventos normais/antigos.

No painel administrativo há um botão:

- **Desativar eventos antigos**: o servidor passa a usar somente o Modo História.
- **Ativar eventos antigos**: os eventos normais voltam a participar do sorteio.

Quando os eventos antigos estão desativados, a função de próxima rodada encerra antes de consultar a tabela `hg_events`. Assim, a introdução e os eventos decorrentes da história são executados um por vez, na ordem cadastrada.

Desmarcar **Misturar com eventos normais** ou clicar em **Reiniciar história agora** também desativa os eventos antigos automaticamente na partida atual e limpa qualquer fala antiga que ainda estivesse na fila do navegador.

A escolha fica salva na partida e é preservada ao usar **Resetar**.

## Atualização

Substitua os arquivos na raiz do GitHub e use no Render:

`Manual Deploy → Clear build cache & deploy`

Mantenha a mesma `DATABASE_URL`. Nenhum evento ou história cadastrada é apagado.
