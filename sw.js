const CACHE_NAME = 'refhub-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json'
];

// Caixa de entrada separada: não altera o banco das imagens locais existentes.
const SHARE_DB_NAME = 'refhub-share-inbox';
const SHARE_DB_VERSION = 1;

function openShareDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, SHARE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('shares')) {
        db.createObjectStore('shares', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeAndroidShare(request) {
  const formData = await request.formData();

  const files = formData.getAll('files')
    .filter(value => value instanceof File && value.size > 0)
    .map(file => ({
      name: file.name || 'imagem-compartilhada',
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || Date.now(),
      blob: file
    }));

  const id = (self.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);

  const payload = {
    id,
    title: String(formData.get('title') || ''),
    text: String(formData.get('text') || ''),
    url: String(formData.get('url') || ''),
    files,
    receivedAt: Date.now()
  };

  const db = await openShareDatabase();

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('shares', 'readwrite');
      tx.objectStore('shares').put(payload);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Falha ao guardar compartilhamento'));
    });
  } finally {
    db.close();
  }

  const destination = new URL('./index.html', self.registration.scope);
  destination.searchParams.set('rh_share', id);
  return Response.redirect(destination.href, 303);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // O cache é apenas um recurso auxiliar. Falha ao baixar um arquivo
    // não pode impedir a instalação/ativação do service worker.
    await Promise.all(ASSETS_TO_CACHE.map(asset =>
      cache.add(asset).catch(error => {
        console.warn('RefHub: não foi possível armazenar no cache:', asset, error);
      })
    ));

    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    await Promise.all(
      cacheNames
        .filter(name => name.startsWith('refhub-') && name !== CACHE_NAME)
        .map(name => caches.delete(name))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const scopeUrl = new URL(self.registration.scope);

  const targetPath = new URL('./share-target', scopeUrl).pathname.replace(/\/+$/, '');
  const requestPath = requestUrl.pathname.replace(/\/+$/, '');

  // Recebe somente o POST destinado ao endpoint de compartilhamento do RefHub.
  if (
    event.request.method === 'POST' &&
    requestUrl.origin === scopeUrl.origin &&
    requestPath === targetPath
  ) {
    event.respondWith(
      storeAndroidShare(event.request).catch(error => {
        console.error('RefHub: erro ao receber compartilhamento Android:', error);

        const fallback = new URL('./index.html', self.registration.scope);
        fallback.searchParams.set('rh_share_error', '1');
        return Response.redirect(fallback.href, 303);
      })
    );
    return;
  }

  // Não intercepta requisições do Firebase/Google Auth.
  if (
    requestUrl.hostname === 'firestore.googleapis.com' ||
    requestUrl.hostname === 'identitytoolkit.googleapis.com' ||
    requestUrl.hostname === 'securetoken.googleapis.com'
  ) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
