const CACHE_NAME = 'refhub-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Caixa de entrada separada: não altera nem atualiza o banco das imagens locais existentes.
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
  await new Promise((resolve, reject) => {
    const tx = db.transaction('shares', 'readwrite');
    tx.objectStore('shares').put(payload);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Falha ao guardar compartilhamento'));
  });
  db.close();

  const destination = new URL('./index.html', self.registration.scope);
  destination.searchParams.set('rh_share', id);
  return Response.redirect(destination.href, 303);
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

// Remove somente caches pertencentes ao RefHub, sem tocar em caches de outros apps no mesmo domínio.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => Promise.all(
      cacheNames
        .filter(name => name.startsWith('refhub-') && name !== CACHE_NAME)
        .map(name => caches.delete(name))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  const shareTargetUrl = new URL('./share-target', self.registration.scope);

  if (event.request.method === 'POST' && requestUrl.pathname === shareTargetUrl.pathname) {
    event.respondWith(
      storeAndroidShare(event.request).catch(error => {
        console.error('RefHub: erro ao receber compartilhamento Android:', error);
        return Response.redirect(new URL('./index.html?rh_share_error=1', self.registration.scope).href, 303);
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
