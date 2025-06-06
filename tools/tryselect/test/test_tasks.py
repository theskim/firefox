# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os

import mozunit
import pytest
from tryselect.tasks import (
    cache_key,
    filter_tasks_by_paths,
    filter_tasks_by_worker_type,
    resolve_tests_by_suite,
)


class task:
    def __init__(self, workerType):
        self.workerType = workerType

    @property
    def task(self):
        return {"workerType": self.workerType}


@pytest.mark.parametrize(
    "tasks, params, expected",
    (
        pytest.param(
            {
                "foobar/xpcshell-1": task("t-unittest-314"),
                "foobar/mochitest": task("t-unittest-157"),
                "foobar/xpcshell-gpu": task("t-unittest-314-gpu"),
                "foobar/xpcshell": task("t-unittest-314"),
            },
            {"try_task_config": {"worker-types": ["t-unittest-314"]}},
            [
                "foobar/xpcshell-1",
                "foobar/xpcshell",
            ],
            id="single worker",
        ),
        pytest.param(
            {
                "foobar/xpcshell-1": task("t-unittest-314"),
                "foobar/mochitest": task("t-unittest-157"),
                "foobar/xpcshell-gpu": task("t-unittest-314-gpu"),
                "foobar/xpcshell": task("t-unittest-314"),
            },
            {
                "try_task_config": {
                    "worker-types": ["t-unittest-314", "t-unittest-314-gpu"]
                }
            },
            [
                "foobar/xpcshell-1",
                "foobar/xpcshell-gpu",
                "foobar/xpcshell",
            ],
            id="multiple workers worker",
        ),
        pytest.param(
            {
                "foobar/xpcshell-1": task("t-unittest-314"),
                "foobar/mochitest": task("t-unittest-157"),
                "foobar/xpcshell-gpu": task("t-unittest-314-gpu"),
                "foobar/xpcshell": task("t-unittest-314"),
            },
            {"try_task_config": {"worker-types": ["t-unittest-157"]}},
            [
                "foobar/mochitest",
            ],
            id="single task",
        ),
        pytest.param(
            {
                "foobar/xpcshell-1": task("t-unittest-314"),
                "foobar/mochitest": task("t-unittest-157"),
                "foobar/xpcshell-gpu": task("t-unittest-314-gpu"),
                "foobar/xpcshell": task("t-unittest-314"),
            },
            {"try_task_config": {"worker-types": []}},
            [
                "foobar/xpcshell-1",
                "foobar/mochitest",
                "foobar/xpcshell-gpu",
                "foobar/xpcshell",
            ],
            id="no worker",
        ),
        pytest.param(
            {
                "foobar/xpcshell-1": task("t-unittest-314"),
                "foobar/mochitest": task("t-unittest-157"),
                "foobar/xpcshell-gpu": task("t-unittest-314-gpu"),
                "foobar/xpcshell": task("t-unittest-314"),
            },
            {"try_task_config": {"worker-types": ["fake-worker"]}},
            [],
            id="invalid worker",
        ),
    ),
)
def test_filter_tasks_by_worker_type(patch_resolver, tasks, params, expected):
    assert list(filter_tasks_by_worker_type(tasks, params)) == expected


def test_filter_tasks_by_paths(patch_resolver):
    tasks = {"foobar/xpcshell-1": {}, "foobar/mochitest": {}, "foobar/xpcshell": {}}

    patch_resolver(["xpcshell"], {})
    assert list(filter_tasks_by_paths(tasks, "dummy")) == []

    patch_resolver([], [{"flavor": "xpcshell"}])
    assert list(filter_tasks_by_paths(tasks, "dummy")) == [
        "foobar/xpcshell-1",
        "foobar/xpcshell",
    ]


@pytest.mark.parametrize(
    "input, tests, expected",
    (
        pytest.param(
            ["xpcshell.js"],
            [{"flavor": "xpcshell", "srcdir_relpath": "xpcshell.js"}],
            {"xpcshell": ["xpcshell.js"]},
            id="single test",
        ),
        pytest.param(
            ["xpcshell.ini"],
            [
                {
                    "flavor": "xpcshell",
                    "srcdir_relpath": "xpcshell.js",
                    "manifest_relpath": "xpcshell.ini",
                },
            ],
            {"xpcshell": ["xpcshell.ini"]},
            id="single manifest",
        ),
        pytest.param(
            ["xpcshell.js", "mochitest.js"],
            [
                {"flavor": "xpcshell", "srcdir_relpath": "xpcshell.js"},
                {"flavor": "mochitest", "srcdir_relpath": "mochitest.js"},
            ],
            {
                "xpcshell": ["xpcshell.js"],
                "mochitest-plain": ["mochitest.js"],
            },
            id="two tests",
        ),
        pytest.param(
            ["test/xpcshell.ini"],
            [
                {
                    "flavor": "xpcshell",
                    "srcdir_relpath": "test/xpcshell.js",
                    "manifest_relpath": os.path.join("test", "xpcshell.ini"),
                },
            ],
            {"xpcshell": ["test/xpcshell.ini"]},
            id="mismatched path separators",
        ),
    ),
)
def test_resolve_tests_by_suite(patch_resolver, input, tests, expected):
    patch_resolver([], tests)
    assert resolve_tests_by_suite(input) == expected


@pytest.mark.parametrize(
    "attr,params,disable_target_task_filter,target_tasks_method,expected",
    (
        ("target_task_set", None, False, None, "target_task_set"),
        ("target_task_set", {"project": "autoland"}, False, None, "target_task_set"),
        (
            "target_task_set",
            {"project": "mozilla-central"},
            False,
            None,
            "target_task_set",
        ),
        ("target_task_set", None, True, None, "target_task_set-uncommon"),
        ("target_task_set", None, False, "foo", "target_task_set-target_foo"),
        ("full_task_set", {"project": "pine"}, False, None, "full_task_set-pine"),
        ("full_task_set", None, True, None, "full_task_set"),
        ("full_task_set", None, True, "foo", "full_task_set-target_foo"),
    ),
)
def test_cache_key(
    attr, params, disable_target_task_filter, target_tasks_method, expected
):
    assert (
        cache_key(attr, params, disable_target_task_filter, target_tasks_method)
        == expected
    )


if __name__ == "__main__":
    mozunit.main()
