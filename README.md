# Hunger Games da Live — versão 4.0.0

Esta versão mantém o mesmo banco de dados e não apaga os eventos já cadastrados.

## Novidade: eventos especiais com consequências

O administrador pode criar um evento principal, por exemplo:

```txt
Um ET invade a arena e {p1} vê a nave pousar.
```

Depois de salvar, clique na seta do evento especial para expandir e cadastrar os eventos decorrentes, como:

```txt
{p1} tenta conversar com o ET.
{p1} encontra uma arma alienígena.
O ET captura {p2}.
```

Cada evento especial tem duas chaves:

- **Misturar com eventos normais ligada:** os eventos decorrentes entram junto com os eventos normais enquanto o especial estiver ativo.
- **Misturar com eventos normais desligada:** enquanto o especial estiver ativo, somente os eventos cadastrados dentro dele podem aparecer.
- **Evento especial ativo:** permite ativar ou desativar todo o grupo sem apagar nada.

Cada evento decorrente também pode ser ativado ou desativado separadamente. A opção **Qualquer fase** é recomendada para a história continuar em qualquer Dia, Noite, Banquete ou evento da arena.

Um evento especial é sorteado no máximo uma vez por partida. Os eventos decorrentes são usados uma vez nessa partida e, quando todos terminam, o jogo volta aos eventos normais.

## O que continua incluído

- Correção de dias e fases repetidos.
- Correção de participantes mortos reaparecendo vivos.
- Rodadas protegidas contra execução simultânea.
- Interface traduzida.
- Botão **Adicionar todos do chat**.
- Comando `!hg todos` sem limite fixo de participantes.
- Editor de eventos normais.
- Modo +18 e eventos +18.

## Atualização no Render

Substitua estes arquivos na raiz do repositório:

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

Não altere nem apague `DATABASE_URL`. A primeira inicialização cria somente as novas tabelas e adiciona uma coluna de controle à tabela de partidas.

Confirme a versão em:

```txt
https://site-jogo-o9d1.onrender.com/version
```

Resposta esperada:

```json
{"version":"4.0.0"}
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
