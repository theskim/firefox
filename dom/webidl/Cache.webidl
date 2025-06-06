/* -*- Mode: IDL; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * The origin of this IDL file is
 * https://w3c.github.io/ServiceWorker/#cache-interface
 */

[Exposed=(Window,Worker),
 Func="cache::Cache::CachesEnabled"]
interface Cache {
  [NewObject]
  Promise<Response> match(RequestInfo request, optional CacheQueryOptions options = {});
  [NewObject]
  Promise<sequence<Response>> matchAll(optional RequestInfo request, optional CacheQueryOptions options = {});
  [NewObject, NeedsCallerType]
  Promise<undefined> add(RequestInfo request);
  [NewObject, NeedsCallerType]
  Promise<undefined> addAll(sequence<RequestInfo> requests);
  [NewObject]
  Promise<undefined> put(RequestInfo request, Response response);
  [NewObject]
  Promise<boolean> delete(RequestInfo request, optional CacheQueryOptions options = {});
  [NewObject]
  Promise<sequence<Request>> keys(optional RequestInfo request, optional CacheQueryOptions options = {});
};

dictionary CacheQueryOptions {
  boolean ignoreSearch = false;
  boolean ignoreMethod = false;
  boolean ignoreVary = false;
};

dictionary CacheBatchOperation {
  DOMString type;
  Request request;
  Response response;
  CacheQueryOptions options;
};
