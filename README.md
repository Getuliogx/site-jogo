# Hunger Games da Live — versão 5.0.0

Esta versão mantém o mesmo banco de dados. Ela não apaga os eventos normais, histórias, participantes ou configurações já cadastradas.

## Modo História no início do painel

O editor de histórias agora aparece logo abaixo da área principal do jogo, antes do editor de eventos normais.

Cada história possui:

- uma introdução;
- vários eventos decorrentes dentro dela;
- seta para expandir ou encolher;
- chave para misturar com eventos normais;
- chave para ativar ou desativar a história inteira;
- ativação separada de cada evento interno.

Exemplo de introdução:

```txt
Um ET invade a arena diante de {p}.
```

## Opção Todos

Na seleção de participantes existe agora a opção **Todos**, no lugar de precisar digitar um número especial.

Ela está disponível em:

- introdução da história;
- eventos decorrentes;
- eventos normais novos;
- edição de eventos normais já existentes.

Ao escolher **Todos**, use no texto:

```txt
{p}
```

ou:

```txt
{todos}
```

O jogo substitui pelo nome de todos os participantes vivos, por exemplo:

```txt
Um ET aparece diante de Ana, Bruno, Carla e Diego.
```

Eventos com **Todos** não aceitam mortes pelo campo `p1`, `p2` etc. Para criar uma morte, escolha de 1 a 4 participantes.

## Narração automática

A página pública e o painel administrativo possuem:

- botão **Ativar narração**;
- seletor de voz;
- botão **Testar voz**.

A narração usa a síntese de voz do próprio navegador. O sistema prioriza uma voz **Google Português do Brasil** quando ela estiver disponível e usa outra voz em português como alternativa.

Por segurança do navegador, é necessário clicar em **Ativar narração** na página que deverá produzir o áudio. Depois disso, cada evento novo é narrado automaticamente.

## Correções e recursos mantidos

- correção de dias e fases repetidos;
- correção de participantes mortos reaparecendo vivos;
- proteção contra duas rodadas executadas ao mesmo tempo;
- interface traduzida;
- botão **Adicionar todos do chat**;
- comando `!hg todos`;
- participantes sem limite fixo;
- eventos +18;
- histórias encadeadas;
- eventos antigos preservados.

## Atualização no Render

Substitua os arquivos na raiz do repositório:

```txt
server.js
package.json
package-lock.json
render.yaml
README.md
```

Depois use:

```txt
Manual Deploy → Clear build cache & deploy
```

Não altere nem apague `DATABASE_URL`.

Confirme a versão em:

```txt
https://site-jogo-o9d1.onrender.com/version
```

Resposta esperada:

```json
{"version":"5.0.0"}
```

## Endereços

Página pública:

```txt
https://site-jogo-o9d1.onrender.com/hungergames?channel=icarolinaporto
```

Painel administrativo:

```txt
https://site-jogo-o9d1.onrender.com/admin/hungergames?channel=icarolinaporto&token=carolina-hg
```

## Comando StreamElements

```txt
$(customapi https://site-jogo-o9d1.onrender.com/hg?token=carolina-hg&channel=$(channel)&user=$(sender)&q=$(queryescape ${1:}))
```

Comandos principais:

```txt
!hg entrar
!hg todos
!hg iniciar
!hg proximo
!hg auto
!hg parar
!hg resetar
!hg +18 ligar
!hg +18 desligar
```
