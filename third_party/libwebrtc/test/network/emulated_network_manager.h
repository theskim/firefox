/*
 *  Copyright (c) 2019 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

#ifndef TEST_NETWORK_EMULATED_NETWORK_MANAGER_H_
#define TEST_NETWORK_EMULATED_NETWORK_MANAGER_H_

#include <functional>
#include <memory>
#include <vector>

#include "absl/base/nullability.h"
#include "api/packet_socket_factory.h"
#include "api/task_queue/task_queue_base.h"
#include "api/test/network_emulation/network_emulation_interfaces.h"
#include "api/test/network_emulation_manager.h"
#include "api/test/time_controller.h"
#include "p2p/base/basic_packet_socket_factory.h"
#include "rtc_base/network.h"
#include "rtc_base/socket_server.h"
#include "rtc_base/thread.h"
#include "test/network/network_emulation.h"

namespace webrtc {
namespace test {

class EmulatedNetworkManager : public EmulatedNetworkManagerInterface {
 public:
  EmulatedNetworkManager(
      absl::Nonnull<TimeController*> time_controller,
      absl::Nonnull<TaskQueueBase*> task_queue,
      absl::Nonnull<EndpointsContainer*> endpoints_container);
  ~EmulatedNetworkManager() override;

  void EnableEndpoint(absl::Nonnull<EmulatedEndpointImpl*> endpoint);
  void DisableEndpoint(absl::Nonnull<EmulatedEndpointImpl*> endpoint);

  absl::Nonnull<rtc::Thread*> network_thread() override {
    return network_thread_.get();
  }
  absl::Nonnull<rtc::NetworkManager*> network_manager() override;
  absl::Nonnull<rtc::PacketSocketFactory*> packet_socket_factory() override {
    return &packet_socket_factory_;
  }
  absl::Nonnull<rtc::SocketFactory*> socket_factory() override {
    return socket_server_;
  }
  absl::Nonnull<std::unique_ptr<rtc::NetworkManager>> ReleaseNetworkManager()
      override;

  std::vector<EmulatedEndpoint*> endpoints() const override {
    return endpoints_container_->GetEndpoints();
  }
  void GetStats(
      std::function<void(EmulatedNetworkStats)> stats_callback) const override;

 private:
  class NetworkManagerImpl;

  const absl::Nonnull<TaskQueueBase*> task_queue_;
  const absl::Nonnull<const EndpointsContainer*> endpoints_container_;

  // Socket server is owned by the `network_thread_'
  const absl::Nonnull<rtc::SocketServer*> socket_server_;

  // The `network_thread_` must outlive `packet_socket_factory_`, because they
  // both refer to the `socket_server_` that is owned by `network_thread_`.
  const absl::Nonnull<std::unique_ptr<rtc::Thread>> network_thread_;
  rtc::BasicPacketSocketFactory packet_socket_factory_;
  absl::Nullable<std::unique_ptr<NetworkManagerImpl>> network_manager_;

  // Keep pointer to the network manager when it is extracted to be injected
  // into PeerConnectionFactory. That is brittle and may crash if a test would
  // try to use emulated network after related PeerConnectionFactory is deleted.
  const absl::Nonnull<NetworkManagerImpl*> network_manager_ptr_;
};

}  // namespace test
}  // namespace webrtc

#endif  // TEST_NETWORK_EMULATED_NETWORK_MANAGER_H_
