# Hunger Games da Live — versão 6.0.0

Sistema com modo história, eventos personalizados, execução automática e prêmio aleatório para o vencedor.

## Automático sem voz

A narração foi removida. Ao iniciar a partida, os eventos começam a rodar sozinhos. No painel administrativo, escolha de 1 a 60 segundos entre um evento e outro e clique em **Salvar tempo**.

A página pública não rola e não acompanha automaticamente os eventos novos; ela permanece exatamente na posição em que a pessoa deixou.

## Prêmio do vencedor

No painel administrativo, envie várias imagens, ative ou desative cada prêmio e personalize o texto com `{vencedor}` e `{premio}`. A configuração fica salva por canal e continua nas próximas partidas.

## Atualização

Mantenha a mesma `DATABASE_URL`. Esta versão não apaga eventos, histórias, participantes nem prêmios cadastrados.
