# Hunger Games da Live — versão 7.0.0

Sistema com modo história, eventos personalizados, execução automática e prêmio aleatório para o vencedor.

## Gerador automático de histórias

No painel administrativo, basta digitar uma categoria, por exemplo **Vampiro**, **Terror**, **Apocalipse** ou **Zumbi**, e clicar em **Gerar história completa**.

O sistema cria automaticamente:

- introdução da história;
- acontecimentos de tensão, itens e alianças;
- eventos de morte suficientes para a quantidade atual de participantes vivos;
- capítulos finais até restar um vencedor.

Categorias diferentes das sugestões também funcionam por meio do gerador genérico. A história criada fica em modo exclusivo, sem misturar os eventos antigos.

As mortes continuam usando a lógica original do jogo: jogadores mortos não voltam, uma morte só é confirmada uma vez e o último sobrevivente nunca é eliminado.

## Automático sem voz

A narração foi removida. Ao iniciar a partida, os eventos começam a rodar sozinhos. No painel administrativo, escolha de 1 a 60 segundos entre um evento e outro e clique em **Salvar tempo**.

A página pública não rola e não acompanha automaticamente os eventos novos; ela permanece exatamente na posição em que a pessoa deixou.

## Prêmio do vencedor

No painel administrativo, envie várias imagens, ative ou desative cada prêmio e personalize o texto com `{vencedor}` e `{premio}`. A configuração fica salva por canal e continua nas próximas partidas.

## Atualização

Mantenha a mesma `DATABASE_URL`. Esta versão não apaga eventos, histórias, participantes nem prêmios cadastrados.
