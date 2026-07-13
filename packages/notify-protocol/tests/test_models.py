import json

from zantiflow_notify import (
    PROTOCOL_VERSION,
    Deliver,
    Hello,
    HelloAck,
    LinkRequest,
    LinkResult,
    parse_backend_message,
)


def test_hello_serializes_with_kind_and_version():
    d = json.loads(Hello(platform="discord", serviceSecret="s").model_dump_json())
    assert d["kind"] == "hello"
    assert d["platform"] == "discord"
    assert d["version"] == PROTOCOL_VERSION


def test_parse_backend_deliver():
    msg = parse_backend_message('{"kind":"deliver","deliveryId":"d1","platformUserId":"u1","text":"hi"}')
    assert isinstance(msg, Deliver)
    assert msg.deliveryId == "d1"
    assert msg.text == "hi"


def test_parse_backend_hello_ack():
    msg = parse_backend_message('{"kind":"hello_ack","ok":true}')
    assert isinstance(msg, HelloAck)
    assert msg.ok is True


def test_parse_backend_link_result():
    msg = parse_backend_message('{"kind":"link_result","token":"t","ok":false,"error":"bad"}')
    assert isinstance(msg, LinkResult)
    assert msg.ok is False
    assert msg.error == "bad"


def test_parse_backend_link_result_echoes_platform_user_id():
    msg = parse_backend_message('{"kind":"link_result","token":"t","ok":true,"platformUserId":"7"}')
    assert isinstance(msg, LinkResult)
    assert msg.platformUserId == "7"


def test_link_request_omits_none_username():
    d = json.loads(LinkRequest(platform="telegram", platformUserId="u", token="tok").model_dump_json(exclude_none=True))
    assert d["kind"] == "link_request"
    assert "platformUsername" not in d
