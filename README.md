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
HG_MAX_PLAYERS=24
HG_ADULT_DEFAULT=0
DATABASE_URL=sua_database_url_real
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
