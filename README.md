# Hunger Games da Live — versão 5.3.0

Esta versão mantém o mesmo banco de dados e **não apaga** eventos normais, histórias ou participantes já cadastrados.

## Correções desta versão

### História exclusiva sem mistura

Quando **Misturar com eventos normais** estiver desligado:

- a introdução da história tem prioridade;
- nenhum evento normal entra antes da introdução na mesma rodada;
- enquanto a história estiver ativa, somente os eventos internos dela são usados;
- ao terminar, os eventos normais voltam apenas na próxima fase.

As chaves **Misturar com eventos normais** e **História ativa** agora são salvas automaticamente ao marcar ou desmarcar.

### Narração corrigida

- A narração agora funciona também na tela administrativa.
- Ao ativar, o navegador é desbloqueado com a mensagem “Narração ativada”.
- Cada fala é reiniciada de forma segura antes do próximo evento.
- Se a voz travar ao iniciar, o sistema tenta novamente uma vez.
- A fala usa um temporizador maior e mantém o mecanismo de voz acordado.
- Se a tela administrativa e a pública estiverem abertas no mesmo navegador, a administrativa tem prioridade para evitar duas vozes ao mesmo tempo.
- Os controles de voz continuam aparecendo somente na tela administrativa.

## Atualização

Substitua os arquivos na raiz do repositório e use no Render:

```txt
Manual Deploy → Clear build cache & deploy
```

Mantenha a mesma `DATABASE_URL`.

Depois confirme:

```txt
/version
```

O retorno deve ser:

```json
{"version":"5.3.0"}
```
