# Hunger Games da Live - Render separado

Este é o Render NOVO do jogo. Ele não mexe no Render antigo do `!add filme`.

## Link do seu Render novo

```txt
https://site-jogo-o9d1.onrender.com
```

## Environment no Render novo

Coloque/ajuste assim, um por um:

```txt
COMMAND_SECRET=carolina-hg
DEFAULT_CHANNEL=icarolinaporto
ALLOWED_CHANNELS=icarolinaporto
ALLOWED_USERS=icarolinaporto,mod1,mod2
HG_ADULT_DEFAULT=0
DATABASE_URL=sua_database_url_real

Não existe mais limite máximo de participantes no código.
```

Para pegar foto do perfil da Twitch, coloque também:

```txt
TWITCH_CLIENT_ID=seu_client_id
TWITCH_CLIENT_SECRET=seu_client_secret
```

## Comando StreamElements

Crie um comando novo `!hg` com esta resposta:

```txt
$(customapi https://site-jogo-o9d1.onrender.com/hg?token=carolina-hg&channel=$(channel)&user=$(sender)&q=$(queryescape ${1:}))
```

## Uso no chat

```txt
!hg entrar
!hg entrar 5
!hg distrito 3
!hg sair
!hg todos
!hg iniciar
!hg proximo
!hg resetar
!hg +18 on
!hg +18 off
```

`iniciar`, `proximo`, `resetar` e `+18` só funcionam para streamer/mods em `ALLOWED_USERS`.

## Página pública

```txt
https://site-jogo-o9d1.onrender.com/hungergames?channel=icarolinaporto
```

## Admin do jogo

```txt
https://site-jogo-o9d1.onrender.com/admin/hungergames?channel=icarolinaporto&token=carolina-hg
```

## Correção feita nesta versão

- O canal correto agora é `icarolinaporto`.
- Se algum link antigo mandar `channel=carolinaporto`, o servidor joga para `icarolinaporto` para não separar os participantes.
- Corrigido para não dar "Canal não autorizado" nesse caso.


## Correção AUTO / admin

Nesta versão:
- O admin com `?token=carolina-hg` não dá mais "Usuário não autorizado".
- Botão `Rodar sozinho` adicionado no admin.
- Comando de chat também funciona:
  `!hg auto`
  `!hg parar`
- Intervalo automático padrão: 12 segundos.
- Pode mudar no Render:
  `HG_AUTO_INTERVAL_MS=12000`


## Layout eventos com imagens

Nesta versão:
- A lista de participantes some quando a partida está rodando.
- Cada evento tenta mostrar as imagens dos participantes citados no texto.
- Imagem em cima, texto do evento embaixo, parecido com simulador.


## Tela só eventos

Nesta versão:
- Ao iniciar a partida, o painel da esquerda some inteiro.
- A tela fica só com Eventos em coluna única.
- Os eventos não ficam mais do lado.
- Foto e nick aparecem dentro de cada evento.


## Correção nick nos eventos e edição

Nesta versão:
- Remove o nome/nick que ficava embaixo da imagem do evento.
- O nick continua apenas no texto do evento.
- O admin do Render agora lista eventos existentes.
- Dá para editar, desativar/ativar e excluir eventos existentes.
- Não altera menu do admin do site principal.


## Forçar remoção de nome embaixo da imagem

Esta versão remove na marra qualquer `.event-name` dentro dos eventos.
Também zera fonte do bloco de imagem para impedir texto/caption embaixo da foto.


## Correção admin/configuração e +18

Nesta versão:
- O modo "só eventos" vale só para a página pública.
- No /admin/hungergames o painel de configuração continua aparecendo mesmo com a partida iniciada.
- Adicionado botão "Adicionar +18 pesado" no admin do Render.
- O pacote adiciona novos eventos adultos mais fortes ao banco.
- Mantém editor de eventos existentes.


## Versão corrigida — dias, mortos e participantes do chat

Esta versão mantém o mesmo banco e não apaga os eventos cadastrados.

Correções e novidades:

- Rodadas protegidas contra execução simultânea. Isso evita repetir a mesma fase ou o mesmo dia quando o automático e o botão/comando são usados quase juntos.
- O modo automático espera uma rodada terminar antes de agendar a próxima.
- Uma pessoa morta não pode voltar a ficar viva por `!hg entrar` nem ao clicar novamente em **Iniciar**.
- Uma partida encerrada só pode começar de novo depois de **Resetar**.
- Atualizações de morte só valem quando a pessoa ainda está viva, evitando mortes duplicadas.
- Botões, fases, tipos, estados e contagem de abates foram traduzidos para português na tela.
- Novo botão **Adicionar todos do chat** no painel administrativo.
- Novo comando de streamer/mod:

```txt
!hg todos
```

O servidor tenta obter a lista oficial da Twitch quando existe um token configurado. Sem esse token, ele usa a conexão automática ao chat da Twitch. Depois de um deploy ou de o Render acordar, pode levar alguns segundos para a lista do chat ficar pronta.

### Limite de participantes

O comando adiciona até o valor configurado em:

```txt
```

Aumente esse valor no Render caso queira colocar mais de 24 pessoas.

### Bots ignorados

Os bots mais comuns já são ignorados. Para acrescentar outros, use no Render:

```txt
HG_IGNORE_CHATTERS=bot1,bot2,bot3
```

### Lista oficial da Twitch — opcional

Para uma lista mais precisa, pode ser configurado um token de usuário da Twitch com a permissão de leitura de participantes do chat:

```txt
TWITCH_CHAT_TOKEN=seu_token_de_usuario
TWITCH_CHAT_MODERATOR=icarolinaporto
```

Isso é opcional; a conexão automática ao chat continua funcionando como alternativa.

## Correção específica — participante morto aparecendo vivo novamente

O erro corrigido aqui era durante a mesma partida: a pessoa aparecia em um evento de morte e depois voltava a aparecer em eventos seguintes como se estivesse viva.

A correção agora:

- grava a rodada inteira em uma única transação no banco;
- atualiza a morte (`alive=0`) e o texto do evento juntos;
- impede duas rodadas de usarem ao mesmo tempo uma lista antiga de participantes vivos;
- confirma novamente quem está vivo antes de montar cada evento;
- impede respostas antigas do painel de sobrescreverem uma atualização mais nova;
- faz o painel ler jogadores e eventos do mesmo instante do banco;
- bloqueia evento do tipo **Morte** sem preencher corretamente o campo **Mortes**.

Essas mudanças não apagam nem recriam a tabela `hg_events` e mantêm os eventos já cadastrados.


## Versão 3.0.0 — pacote pronto para substituir a raiz

- Arquivos do ZIP ficam diretamente na raiz para evitar criar `site-jogo-main/site-jogo-main`.
- HTML e API usam `Cache-Control: no-store` para o navegador não continuar exibindo a interface antiga.
- Rota de conferência: `/version`, que deve responder `{"version":"3.2.0"}`.
- Mantém as correções de dias repetidos, mortos reaparecendo, tradução e `!hg todos`.
