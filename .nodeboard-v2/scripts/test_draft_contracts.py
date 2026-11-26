"""Check proposed structural contracts; this does not validate graph semantics."""
import copy
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / ".nodeboard-v2" / "contracts"
FIXTURES = ROOT / ".nodeboard-v2" / "fixtures"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


SNAPSHOT = load(CONTRACTS / "snapshot.schema.json")
OPERATIONS = load(CONTRACTS / "operations.schema.json")
DIAGNOSTICS = load(CONTRACTS / "diagnostics.schema.json")
EXAMPLE = load(FIXTURES / "v2-draft-valid.json")
REGISTRY = Registry().with_resource(SNAPSHOT["$id"], Resource.from_contents(SNAPSHOT))
FORMAT_CHECKER = FormatChecker()
if "date-time" not in FORMAT_CHECKER.checkers:
    raise RuntimeError("Install jsonschema[format] to validate date-time fields.")
SNAPSHOT_VALIDATOR = Draft202012Validator(SNAPSHOT, format_checker=FORMAT_CHECKER)
OPERATIONS_VALIDATOR = Draft202012Validator(OPERATIONS, registry=REGISTRY, format_checker=FORMAT_CHECKER)
DIAGNOSTICS_VALIDATOR = Draft202012Validator(DIAGNOSTICS, registry=REGISTRY)


class DraftContractsTest(unittest.TestCase):
    def test_schemas_and_example(self):
        Draft202012Validator.check_schema(SNAPSHOT)
        Draft202012Validator.check_schema(OPERATIONS)
        Draft202012Validator.check_schema(DIAGNOSTICS)
        self.assertEqual(list(SNAPSHOT_VALIDATOR.iter_errors(EXAMPLE)), [])
        self.assertEqual(EXAMPLE["graph"]["entities"][0]["properties"]["prop-extension"], "00123")

    def test_bad_snapshot_fields_are_rejected(self):
        cases = []
        graph = copy.deepcopy(EXAMPLE)
        graph["version"] = 1
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["entities"][0]["id"] = "item-a\n"
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        del graph["graph"]["relationships"][2]["legacy"]
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        del graph["views"][1]["ownerId"]
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["views"][0]["viewport"]["zoom"] = 0
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["relationships"][0]["provenance"] = [{"sourceId": "source", "confidence": 1.1}]
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["relationships"][0]["provenance"] = [{"sourceId": "source", "verifiedAt": "not-a-date"}]
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["relationships"][0]["provenance"] = [{"sourceId": "source", "verifiedAt": "0000-01-01T00:00:00Z"}]
        cases.append(graph)
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["relationships"][0]["provenance"] = [{"sourceId": "source", "validFrom": "invalid"}]
        cases.append(graph)
        for case in cases:
            with self.subTest(case=case):
                self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(case))

    def test_atomic_batch_structure(self):
        batch = {
            "protocolVersion": 2,
            "snapshotVersion": 2,
            "operationId": "op-1",
            "baseRevision": 0,
            "operations": [
                {"type": "entity.put", "entity": EXAMPLE["graph"]["entities"][0]},
                {"type": "relationship.put", "relationship": EXAMPLE["graph"]["relationships"][0]},
                {"type": "view.delete", "id": "view-personal"},
            ],
        }
        self.assertEqual(list(OPERATIONS_VALIDATOR.iter_errors(batch)), [])
        boundary = copy.deepcopy(batch)
        boundary["baseRevision"] = 9007199254740990
        boundary["operations"] = [{"type": "view.delete", "id": "view-personal"}] * 100
        self.assertTrue(OPERATIONS_VALIDATOR.is_valid(boundary))
        for mutate in (
            lambda b: b.update(protocolVersion=1),
            lambda b: b.update(baseRevision=-1),
            lambda b: b.update(baseRevision=9007199254740991),
            lambda b: b.update(operations=[]),
            lambda b: b.update(operations=[{"type": "view.delete", "id": "view-personal"}] * 101),
            lambda b: b["operations"][0]["entity"].pop("id"),
            lambda b: b["operations"].append({"type": "unknown", "id": "x"}),
        ):
            invalid = copy.deepcopy(batch)
            mutate(invalid)
            self.assertFalse(OPERATIONS_VALIDATOR.is_valid(invalid))

    def test_cross_references_need_semantic_validation(self):
        graph = copy.deepcopy(EXAMPLE)
        graph["graph"]["relationships"][0]["to"] = "missing"
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_enum_and_list_definitions_require_options_and_item_types(self):
        graph = copy.deepcopy(EXAMPLE)
        definition = graph["ontology"]["propertyDefinitions"][0]
        definition["dataType"] = "enum"
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        definition["enumValues"] = ["open", "closed"]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        definition["enumValues"] = []
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        definition["enumValues"] = ["open", "open"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        definition["dataType"] = "list"
        definition["enumValues"] = ["open"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        definition["listItemType"] = "enum"
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        del definition["enumValues"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_required_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        constraint = {"id": "req", "kind": "required", "parameters": {"classId": "class-item", "propertyId": "prop-extension"}}
        graph["ontology"]["constraints"] = [constraint]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        del constraint["parameters"]["propertyId"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        constraint["parameters"]["propertyId"] = "prop-extension"
        constraint["parameters"]["extra"] = True
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_cardinality_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classId": "class-item", "relationshipTypeId": "rel-support", "direction": "out", "minimum": 1}
        graph["ontology"]["constraints"] = [{"id": "card", "kind": "cardinality", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        for key, value in (("minimum", 0.5), ("minimum", -1), ("direction", "both")):
            invalid = copy.deepcopy(graph)
            invalid["ontology"]["constraints"][0]["parameters"][key] = value
            self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(invalid))
        del parameters["minimum"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_uniqueness_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classId": "class-item", "propertyId": "prop-extension"}
        graph["ontology"]["constraints"] = [{"id": "unique", "kind": "uniqueness", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["extra"] = True
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        del parameters["extra"]
        del parameters["propertyId"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_disjointness_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classIds": ["class-item", "other"]}
        graph["ontology"]["constraints"] = [{"id": "disjoint", "kind": "disjointness", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["classIds"] = ["class-item"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["classIds"] = ["class-item", "class-item"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_acyclic_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"relationshipTypeId": "rel-support"}
        graph["ontology"]["constraints"] = [{"id": "acyclic", "kind": "acyclic", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["extra"] = True
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        del parameters["extra"]
        del parameters["relationshipTypeId"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_allowed_target_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classId": "class-item", "relationshipTypeId": "rel-support", "targetClassIds": ["class-item"]}
        graph["ontology"]["constraints"] = [{"id": "target", "kind": "allowedTarget", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["targetClassIds"] = []
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["targetClassIds"] = ["class-item", "class-item"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["targetClassIds"] = ["class-item"]
        parameters["extra"] = True
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_conditional_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classId": "class-item", "when": {"propertyId": "prop-extension", "equals": "00123"}, "requirePropertyIds": ["prop-extension"]}
        graph["ontology"]["constraints"] = [{"id": "conditional", "kind": "conditional", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["requirePropertyIds"] = []
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["requirePropertyIds"] = ["prop-extension"]
        del parameters["when"]["equals"]
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_pattern_constraint_parameter_shape(self):
        graph = copy.deepcopy(EXAMPLE)
        parameters = {"classId": "class-item", "propertyId": "prop-extension", "syntax": "glob", "pattern": "00*"}
        graph["ontology"]["constraints"] = [{"id": "pattern", "kind": "pattern", "parameters": parameters}]
        self.assertTrue(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["syntax"] = "regex"
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))
        parameters["syntax"] = "glob"
        parameters["pattern"] = "x" * 257
        self.assertFalse(SNAPSHOT_VALIDATOR.is_valid(graph))

    def test_diagnostic_structure_and_json_pointer_escaping(self):
        diagnostic = {
            "code": "REFERENCE_NOT_FOUND",
            "severity": "error",
            "path": "/graph/relationships/0/to",
            "entityId": "edge-a",
            "message": "Relationship target does not exist.",
        }
        self.assertTrue(DIAGNOSTICS_VALIDATOR.is_valid(diagnostic))
        diagnostic["path"] = "/properties/a~1b~0c"
        self.assertTrue(DIAGNOSTICS_VALIDATOR.is_valid(diagnostic))
        for key, value in (("path", "/bad~2escape"), ("path", "missing-slash"), ("severity", "critical"), ("code", "not_stable"), ("code", "VALID\n")):
            invalid = dict(diagnostic)
            invalid[key] = value
            self.assertFalse(DIAGNOSTICS_VALIDATOR.is_valid(invalid))


if __name__ == "__main__":
    unittest.main()
