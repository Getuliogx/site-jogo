# Hunger Games da Live — versão 5.2.0

Esta versão mantém o mesmo banco de dados e **não apaga** eventos normais, histórias, participantes ou configurações já cadastradas.

## Eventos, voz e rolagem sincronizados

A página consulta novos acontecimentos aproximadamente a cada `0,8 segundo`.

Quando chegam eventos novos, eles entram em uma fila e são apresentados nesta ordem:

1. o cartão do evento aparece;
2. a página rola automaticamente até esse cartão;
3. o cartão fica destacado;
4. a voz começa a narrar o mesmo texto;
5. somente quando a fala termina o próximo evento é exibido.

Quando a narração estiver desligada, os eventos continuam aparecendo e rolando rapidamente, sem esperar uma fala.

## Controles somente no painel administrativo

Os controles abaixo aparecem apenas em:

```txt
/admin/hungergames
```

- Ativar ou desativar narração;
- escolher a voz;
- ajustar a velocidade;
- testar a voz.

Eles não aparecem nas páginas públicas:

```txt
/hungergames
/jogos/hunger
```

A página pública usa automaticamente a configuração feita no painel administrativo no mesmo navegador. Alterações são enviadas para a página pública aberta por armazenamento compartilhado e `BroadcastChannel`.

## Recursos mantidos

- campo de pessoas com qualquer número inteiro ou `Todos`;
- marcadores `{p1}`, `{p2}`, `{p10}` e superiores;
- `{p}` ou `{todos}` para todos os participantes vivos;
- correção de dias e fases repetidos;
- correção de participantes mortos reaparecendo vivos;
- botão **Adicionar todos do chat**;
- comando `!hg todos`;
- participantes sem limite fixo;
- Modo História e eventos decorrentes;
- chave para misturar histórias com eventos normais;
- eventos +18;
- interface traduzida.

## Atualização no Render

1. Extraia o ZIP.
2. Substitua os arquivos na raiz do repositório do GitHub.
3. Não altere nem apague `DATABASE_URL`.
4. No Render, use **Manual Deploy → Clear build cache & deploy**.
5. Abra `/version` e confirme:

```json
{"version":"5.2.0"}
```

Depois, abra o painel administrativo e pressione `Ctrl + F5`.
