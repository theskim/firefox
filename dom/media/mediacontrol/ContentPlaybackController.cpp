/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ContentPlaybackController.h"

#include "MediaControlUtils.h"
#include "mozilla/dom/ContentMediaController.h"
#include "mozilla/dom/MediaSession.h"
#include "mozilla/dom/Navigator.h"
#include "mozilla/dom/WindowContext.h"
#include "nsFocusManager.h"

// avoid redefined macro in unified build
#undef LOG
#define LOG(msg, ...)                        \
  MOZ_LOG(gMediaControlLog, LogLevel::Debug, \
          ("ContentPlaybackController=%p, " msg, this, ##__VA_ARGS__))

namespace mozilla::dom {

ContentPlaybackController::ContentPlaybackController(
    BrowsingContext* aContext) {
  MOZ_ASSERT(aContext);
  mBC = aContext;
}

MediaSession* ContentPlaybackController::GetMediaSession() const {
  RefPtr<nsPIDOMWindowOuter> window = mBC->GetDOMWindow();
  if (!window) {
    return nullptr;
  }

  RefPtr<Navigator> navigator = window->GetNavigator();
  if (!navigator) {
    return nullptr;
  }

  return navigator->HasCreatedMediaSession() ? navigator->MediaSession()
                                             : nullptr;
}

void ContentPlaybackController::NotifyContentMediaControlKeyReceiver(
    MediaControlKey aKey, Maybe<SeekDetails> aDetails) {
  if (RefPtr<ContentMediaControlKeyReceiver> receiver =
          ContentMediaControlKeyReceiver::Get(mBC)) {
    LOG("Handle '%s' in default behavior for BC %" PRIu64,
        GetEnumString(aKey).get(), mBC->Id());
    receiver->HandleMediaKey(aKey, aDetails);
  }
}

void ContentPlaybackController::NotifyMediaSession(MediaSessionAction aAction) {
  MediaSessionActionDetails details;
  details.mAction = aAction;
  NotifyMediaSession(details);
}

void ContentPlaybackController::NotifyMediaSession(
    const MediaSessionActionDetails& aDetails) {
  if (RefPtr<MediaSession> session = GetMediaSession()) {
    LOG("Handle '%s' in media session behavior for BC %" PRIu64,
        GetEnumString(aDetails.mAction).get(), mBC->Id());
    MOZ_ASSERT(session->IsActive(), "Notify inactive media session!");
    session->NotifyHandler(aDetails);
  }
}

void ContentPlaybackController::NotifyMediaSessionWhenActionIsSupported(
    MediaSessionAction aAction) {
  if (IsMediaSessionActionSupported(aAction)) {
    NotifyMediaSession(aAction);
  }
}

bool ContentPlaybackController::IsMediaSessionActionSupported(
    MediaSessionAction aAction) const {
  RefPtr<MediaSession> session = GetMediaSession();
  return session ? session->IsActive() && session->IsSupportedAction(aAction)
                 : false;
}

Maybe<uint64_t> ContentPlaybackController::GetActiveMediaSessionId() const {
  RefPtr<WindowContext> wc = mBC->GetTopWindowContext();
  return wc ? wc->GetActiveMediaSessionContextId() : Nothing();
}

void ContentPlaybackController::Focus() {
  // Focus is not part of the MediaSession standard, so always use the
  // default behavior and focus the window currently playing media.
  if (nsCOMPtr<nsPIDOMWindowOuter> win = mBC->GetDOMWindow()) {
    nsFocusManager::FocusWindow(win, CallerType::System);
  }
}

void ContentPlaybackController::Play() {
  const MediaSessionAction action = MediaSessionAction::Play;
  RefPtr<MediaSession> session = GetMediaSession();
  if (IsMediaSessionActionSupported(action)) {
    NotifyMediaSession(action);
  }
  // We don't want to arbitrarily call play default handler, because we want to
  // resume the frame which a user really gets interest in, not all media in the
  // same page. Therefore, we would only call default handler for `play` when
  // (1) We don't have an active media session (If we have one, the play action
  // handler should only be triggered on that session)
  // (2) Active media session without setting action handler for `play`
  else if (!GetActiveMediaSessionId() || (session && session->IsActive())) {
    NotifyContentMediaControlKeyReceiver(MediaControlKey::Play);
  }
}

void ContentPlaybackController::Pause() {
  const MediaSessionAction action = MediaSessionAction::Pause;
  if (IsMediaSessionActionSupported(action)) {
    NotifyMediaSession(action);
  } else {
    NotifyContentMediaControlKeyReceiver(MediaControlKey::Pause);
  }
}

void ContentPlaybackController::SeekBackward(double aSeekOffset) {
  MediaSessionActionDetails details;
  details.mAction = MediaSessionAction::Seekbackward;
  details.mSeekOffset.Construct(aSeekOffset);
  RefPtr<MediaSession> session = GetMediaSession();
  if (IsMediaSessionActionSupported(details.mAction)) {
    NotifyMediaSession(details);
  } else if (!GetActiveMediaSessionId() || (session && session->IsActive())) {
    NotifyContentMediaControlKeyReceiver(MediaControlKey::Seekbackward,
                                         Some(SeekDetails(aSeekOffset)));
  }
}

void ContentPlaybackController::SeekForward(double aSeekOffset) {
  MediaSessionActionDetails details;
  details.mAction = MediaSessionAction::Seekforward;
  details.mSeekOffset.Construct(aSeekOffset);
  RefPtr<MediaSession> session = GetMediaSession();
  if (IsMediaSessionActionSupported(details.mAction)) {
    NotifyMediaSession(details);
  } else if (!GetActiveMediaSessionId() || (session && session->IsActive())) {
    NotifyContentMediaControlKeyReceiver(MediaControlKey::Seekforward,
                                         Some(SeekDetails(aSeekOffset)));
  }
}

void ContentPlaybackController::PreviousTrack() {
  NotifyMediaSessionWhenActionIsSupported(MediaSessionAction::Previoustrack);
}

void ContentPlaybackController::NextTrack() {
  NotifyMediaSessionWhenActionIsSupported(MediaSessionAction::Nexttrack);
}

void ContentPlaybackController::SkipAd() {
  NotifyMediaSessionWhenActionIsSupported(MediaSessionAction::Skipad);
}

void ContentPlaybackController::Stop() {
  const MediaSessionAction action = MediaSessionAction::Stop;
  if (IsMediaSessionActionSupported(action)) {
    NotifyMediaSession(action);
  } else {
    NotifyContentMediaControlKeyReceiver(MediaControlKey::Stop);
  }
}

void ContentPlaybackController::SeekTo(double aSeekTime, bool aFastSeek) {
  MediaSessionActionDetails details;
  details.mAction = MediaSessionAction::Seekto;
  details.mSeekTime.Construct(aSeekTime);
  RefPtr<MediaSession> session = GetMediaSession();
  if (aFastSeek) {
    details.mFastSeek.Construct(aFastSeek);
  }
  if (IsMediaSessionActionSupported(details.mAction)) {
    NotifyMediaSession(details);
  } else if (!GetActiveMediaSessionId() || (session && session->IsActive())) {
    NotifyContentMediaControlKeyReceiver(
        MediaControlKey::Seekto, Some(SeekDetails(aSeekTime, aFastSeek)));
  }
}

void ContentMediaControlKeyHandler::HandleMediaControlAction(
    BrowsingContext* aContext, const MediaControlAction& aAction) {
  MOZ_ASSERT(aContext);
  // The web content doesn't exist in this browsing context.
  if (!aContext->GetDocShell()) {
    return;
  }
  if (aAction.mKey.isNothing()) {
    MOZ_ASSERT_UNREACHABLE("Invalid media control key.");
    return;
  }
  ContentPlaybackController controller(aContext);
  switch (aAction.mKey.value()) {
    case MediaControlKey::Focus:
      controller.Focus();
      return;
    case MediaControlKey::Play:
      controller.Play();
      return;
    case MediaControlKey::Pause:
      controller.Pause();
      return;
    case MediaControlKey::Playpause:
      MOZ_ASSERT_UNREACHABLE("Invalid media control key.");
      return;
    case MediaControlKey::Stop:
      controller.Stop();
      return;
    case MediaControlKey::Previoustrack:
      controller.PreviousTrack();
      return;
    case MediaControlKey::Nexttrack:
      controller.NextTrack();
      return;
    case MediaControlKey::Seekbackward: {
      const SeekDetails& details = *aAction.mDetails;
      MOZ_ASSERT(details.mRelativeSeekOffset);
      controller.SeekBackward(details.mRelativeSeekOffset.value());
      return;
    }
    case MediaControlKey::Seekforward: {
      const SeekDetails& details = *aAction.mDetails;
      MOZ_ASSERT(details.mRelativeSeekOffset);
      controller.SeekForward(details.mRelativeSeekOffset.value());
      return;
    }
    case MediaControlKey::Skipad:
      controller.SkipAd();
      return;
    case MediaControlKey::Seekto: {
      const SeekDetails& details = *aAction.mDetails;
      MOZ_ASSERT(details.mAbsolute);
      controller.SeekTo(details.mAbsolute->mSeekTime,
                        details.mAbsolute->mFastSeek);
      return;
    }
    default:
      MOZ_ASSERT_UNREACHABLE("Invalid media control key.");
  };
}

}  // namespace mozilla::dom
