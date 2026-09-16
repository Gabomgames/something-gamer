# Something Gamer: atualização da comunidade

## Novidades da versão 14

- Configurações com temas Padrão SG, escuro e claro, apresentação da logo, modo compacto e redução de movimento.
- Tutorial animado de primeiro acesso e central de suporte integrada ao Firestore.
- Navegação e componentes reorganizados para celulares e favicon do SG em todas as páginas.
- Família de selos simples: Verificado, seguido pela Now e seguido pelo SG.
- Chat em tempo real redesenhado: mensagens diretas, servidores, canais, busca, emojis, convite por link, envio com Enter e exclusão das próprias mensagens.
- Eventos comunitários: membros publicam eventos, recebem participantes em tempo real e podem denunciar conteúdo inadequado.
- Área empresarial: solicitação de presença oficial e publicação somente após aprovação administrativa.
- Moderação no painel: análise de empresas, denúncias e remoção de eventos.
- Segurança de conta: idade mínima de 13 anos, dados de nascimento privados, validação de conteúdo, revisão de foto, denúncias com provas, advertências, suspensões e banimento.

O site publicado sai de `dist/`. Rode `npm install` uma vez e, antes de publicar, `npm run verificar && npm run build` (ou `npm run deploy`, que faz os três passos). O código-fonte continua legível no repositório; só o `dist/` é empacotado e ofuscado, e ele não vai para o git. Publique com `firebase deploy --only hosting,firestore:rules,firestore:indexes,storage,functions`. Para republicar a integração Steam, rode `npx wrangler deploy` dentro de `something-gamer-api`.

O feed fica em `feed.html`, separado do perfil (`dashboard.html`). Publicações de texto, notícias, enquetes, votos, curtidas, comentários e exclusão das próprias postagens usam Firebase Authentication e Firestore. Não abra os HTML pelo protocolo `file://`: use Firebase Hosting ou um servidor local (como Live Server no VS Code).

Para disponibilizar essas alterações no projeto Firebase já configurado, a partir da pasta raiz rode `firebase use something-gamer` e `firebase deploy --only hosting,firestore:rules,firestore:indexes,storage,functions`. O `firestore:indexes` é novo e obrigatório: sem o índice de `notifications` as notificações não carregam. Confirme antes de publicar que esta é a conta/projeto corretos; atualize a página depois do deploy. O usuário precisa estar logado. Se aparecer erro de permissão ao postar, confira o deploy das regras do Firestore.

Fotos/vídeos requerem armazenamento configurado. Administração, cobrança, e-mails transacionais e Xbox/PlayStation ainda exigem backend, credenciais de servidor e publicação próprios. Não coloque chaves privadas em arquivos JavaScript públicos. O Worker de `something-gamer-api` contém o fluxo da Steam, mas só entra em funcionamento após a configuração e a publicação descritas abaixo. Nada nesta versão cobra usuários nem envia e-mails automaticamente.

## Ativar a Steam no Cloudflare

1. No terminal, dentro de `something-gamer-api`, rode `npx wrangler kv namespace create SG_AUTH`. Copie o ID retornado para `kv_namespaces[0].id` no `wrangler.jsonc`.
2. Rode `npx wrangler secret put STEAM_API_KEY` e cole sua chave da Steam quando solicitado.
3. Rode `npx wrangler deploy`. A URL configurada atualmente é `https://something-gamer-api.something-gamer-nowtech.workers.dev`; se o Cloudflare fornecer outra, atualize `steamApiBaseUrl` em `config.js`.
4. Na raiz do projeto, publique a interface e as regras com `firebase deploy --only firestore:rules,hosting`.

O fluxo usa Steam OpenID no Worker, guarda os códigos temporários por dez minutos no KV e entrega os dados somente ao mesmo usuário autenticado no Firebase. A Steam só fornece biblioteca e conquistas quando o perfil e os detalhes de jogos estão públicos.

## Selos

- **Gamer Verificado:** depende de assinatura ativa e aprovação administrativa.
- **A Now segue:** concedido ou removido exclusivamente pelo administrador.
- **O SG segue:** concedido ou removido exclusivamente pelo administrador.
- Criadores de conteúdo verificados podem escolher azul, roxo, dourado, rosa ou verde para o selo de verificação. Contas comuns usam o azul oficial.

Os reconhecimentos Now e SG ficam no campo protegido `badges` do usuário. A interface do perfil não permite que o usuário altere esses campos. O painel administrativo e a ação `setBadge` do backend fazem a concessão oficial.
