/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef NetworkConnectivityService_h_
#define NetworkConnectivityService_h_

#include "nsINetworkConnectivityService.h"
#include "nsCOMPtr.h"
#include "nsIObserver.h"
#include "nsIDNSListener.h"
#include "nsIStreamListener.h"
#include "mozilla/net/DNS.h"
#include "mozilla/Mutex.h"

namespace mozilla {
namespace net {

class NetworkConnectivityService : public nsINetworkConnectivityService,
                                   public nsIObserver,
                                   public nsIDNSListener,
                                   public nsIStreamListener {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSINETWORKCONNECTIVITYSERVICE
  NS_DECL_NSIOBSERVER
  NS_DECL_NSIDNSLISTENER
  NS_DECL_NSISTREAMLISTENER
  NS_DECL_NSIREQUESTOBSERVER

  already_AddRefed<AddrInfo> MapNAT64IPs(AddrInfo* aNewRRSet);

  static already_AddRefed<NetworkConnectivityService> GetSingleton();

 private:
  NetworkConnectivityService() = default;
  virtual ~NetworkConnectivityService() = default;

  nsresult Init();
  // Calls all the check methods
  void PerformChecks();

  void SaveNAT64Prefixes(nsIDNSRecord* aRecord);

  already_AddRefed<nsIChannel> SetupIPCheckChannel(bool ipv4);

  // Will be set to OK if the DNS request returned in IP of this type,
  //                NOT_AVAILABLE if that type of resolution is not available
  //                UNKNOWN if the check wasn't performed
  Atomic<ConnectivityState, Relaxed> mDNSv4{ConnectivityState::UNKNOWN};
  Atomic<ConnectivityState, Relaxed> mDNSv6{ConnectivityState::UNKNOWN};
  Atomic<ConnectivityState, Relaxed> mDNS_HTTPS{ConnectivityState::UNKNOWN};

  Atomic<ConnectivityState, Relaxed> mIPv4{ConnectivityState::UNKNOWN};
  Atomic<ConnectivityState, Relaxed> mIPv6{ConnectivityState::UNKNOWN};

  Atomic<ConnectivityState, Relaxed> mNAT64{ConnectivityState::UNKNOWN};

  nsTArray<NetAddr> mNAT64Prefixes{ConnectivityState::UNKNOWN};

  nsCOMPtr<nsICancelable> mDNSv4Request;
  nsCOMPtr<nsICancelable> mDNSv6Request;
  nsCOMPtr<nsICancelable> mDNS_HTTPSRequest;
  nsCOMPtr<nsICancelable> mNAT64Request;

  nsCOMPtr<nsIChannel> mIPv4Channel;
  nsCOMPtr<nsIChannel> mIPv6Channel;

  bool mCheckedNetworkId = false;
  bool mHasNetworkId = false;
  bool mIdleStartupDone{false};

  Mutex mLock MOZ_UNANNOTATED{"nat64prefixes"};
};

}  // namespace net
}  // namespace mozilla

#endif  // NetworkConnectivityService_h_
