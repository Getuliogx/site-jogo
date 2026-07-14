# Hunger Games da Live — v5.4.0

Versão corrigida do modo história e da narração.

## Modo história

Com **Misturar com eventos normais** desligado, a história ganha prioridade total. A introdução aparece primeiro e os acontecimentos internos seguem a ordem cadastrada. Nenhum evento normal entra enquanto a história estiver em andamento.

Ao desligar essa chave durante uma partida, a história é preparada novamente e começa pela introdução no próximo passo automático.

## Narração

A voz padrão é **Google online — português do Brasil**. O servidor envia o áudio em partes curtas e o navegador usa uma voz local como alternativa caso o serviço online falhe. Evento, rolagem e voz são processados em uma única fila.

Os controles de narração aparecem somente em `/admin/hungergames`.

## Atualização

Substitua os arquivos na raiz do GitHub e use no Render:

`Manual Deploy → Clear build cache & deploy`

Mantenha a mesma `DATABASE_URL`. Os eventos e histórias já cadastrados não são apagados.
