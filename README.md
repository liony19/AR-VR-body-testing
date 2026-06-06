# WebXR CV Game

Prototipo em que o computador usa a camera para visao computacional e o celular roda o jogo. A ponte entre os dois e uma sala WebSocket local.

## Como rodar

Nao precisa instalar dependencias. O servidor usa apenas modulos nativos do Node.

1. Entre na pasta do projeto:

```bash
cd outputs/webxr-cv-game
```

2. Inicie o servidor:

```bash
npm start
```

3. No computador, abra:

```text
http://localhost:3000/camera
```

4. No celular, conectado ao mesmo Wi-Fi, abra a URL mostrada na tela da camera ou no terminal. Ela tera este formato:

```text
http://SEU-IP-LOCAL:3000/game?room=DEMO
```

## Fluxo

- A pagina `/camera` acessa a webcam do computador.
- Voce clica em uma cor na imagem para usar como marcador visual, ou troca para modo movimento.
- A visao computacional calcula centro, direcao, area e pulso.
- O servidor repassa os comandos para a sala.
- A pagina `/game` no celular usa esses comandos para mover o jogador.
- O botao `AR` tenta abrir uma sessao WebXR `immersive-ar` quando o navegador e a origem permitem.

## Teste rapido

- Use um objeto de cor forte como marcador, por exemplo uma tampa ou papel colorido.
- Abra `/camera`, clique em `iniciar camera` e depois clique no marcador na imagem.
- Abra `/game` no celular usando a mesma sala.
- Mova o marcador para esquerda, direita, cima e baixo.
- Movimentos rapidos geram pulso/boost no jogo.
- Se quiser testar sem webcam, use WASD ou setas na pagina da camera. Espaco dispara pulso.

Se o celular nao abrir a URL local, confira se computador e celular estao no mesmo Wi-Fi e se o firewall liberou o Node na porta `3000`.

## Observacoes sobre WebXR

WebXR imersivo em celular normalmente exige HTTPS. O jogo 2D funciona em HTTP na rede local, mas o modo AR pode ficar indisponivel se a pagina for aberta como `http://IP:3000`.

Para testar AR de verdade, use uma origem segura, por exemplo:

- Um tunnel HTTPS como ngrok ou Cloudflare Tunnel apontando para `localhost:3000`.
- Um certificado local confiavel instalado no celular.
- Configuracao de desenvolvimento do navegador que trate a origem local como segura.

## Estrutura

```text
server.js              Servidor HTTP + WebSocket sem dependencias externas
public/index.html      Tela de sala e links
public/camera.html     Console da webcam e visao computacional
public/game.html       Jogo mobile com WebXR opcional
public/ws.js           Cliente WebSocket compartilhado
public/camera.js       Tracking por cor/movimento
public/game.js         Loop do jogo e renderizacao WebXR
public/styles.css      Interface responsiva
```
