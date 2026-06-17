# Hunger Games da Live - Render separado

Este projeto é separado do Render antigo do comando `!add`. Não mexe no comando de adicionar filme.

## Criar Render novo

Crie um serviço novo no Render usando estes arquivos.

Build Command:

```txt
npm install
```

Start Command:

```txt
npm start
```

## Environment no Render novo

```txt
COMMAND_SECRET=carolina-hg
DEFAULT_CHANNEL=carolinaporto
ALLOWED_CHANNELS=carolinaporto
ALLOWED_USERS=carolinaporto,mod1,mod2
HG_MAX_PLAYERS=24
HG_ADULT_DEFAULT=0
DATABASE_URL=sua_database_url
```

Para pegar imagem do perfil da Twitch, coloque também:

```txt
TWITCH_CLIENT_ID=seu_client_id
TWITCH_CLIENT_SECRET=seu_client_secret
```

Sem essas duas variáveis, o jogo pega nick, mas não pega avatar da Twitch.

## Comando StreamElements

Crie um comando novo `!hg`:

```txt
$(customapi https://site-ca-hunger-games-live.onrender.com/hg?token=carolina-hg&channel=$(channel)&user=$(sender)&q=$(queryescape ${1:}))
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
https://site-ca-hunger-games-live.onrender.com/hungergames?channel=carolinaporto
```

## Admin

```txt
https://site-ca-hunger-games-live.onrender.com/admin/hungergames?channel=carolinaporto&token=carolina-hg
```
