import copy
import unittest
from install import normalize_groups, prune_new_route


class ExistingRoutes(unittest.TestCase):
    def setUp(self):
        self.old = {'routes': [
            {'match': [{'path': ['/commerce/naver']}], 'group': 'group3', 'handle': [{'handler': 'reverse_proxy', 'upstream': 'localhost:8788'}]},
            {'match': [{'path': ['/v2/sender/send'], 'header': {'X-Relay-Secret': ['existing-secret']}}], 'group': 'group3'},
            {'group': 'group3', 'handle': [{'handler': 'static_response', 'status_code': 403}]}
        ]}

    def compatible(self, proposed):
        return normalize_groups(prune_new_route(proposed)) == normalize_groups(self.old)

    def test_addition_with_renumbered_groups(self):
        new = copy.deepcopy(self.old)
        for route in new['routes']:
            route['group'] = 'group4'
        new['routes'].insert(1, {'match': [{'path': ['/socialfactory/aligo/send']}], 'group': 'group4'})
        self.assertTrue(self.compatible(new))

    def test_changed_existing_auth_is_rejected(self):
        new = copy.deepcopy(self.old)
        new['routes'][1]['match'][0]['header']['X-Relay-Secret'] = ['different']
        self.assertFalse(self.compatible(new))

    def test_changed_existing_upstream_is_rejected(self):
        new = copy.deepcopy(self.old)
        new['routes'][0]['handle'][0]['upstream'] = 'example.com'
        self.assertFalse(self.compatible(new))

    def test_group_membership_change_is_rejected(self):
        new = copy.deepcopy(self.old)
        new['routes'][1]['group'] = 'separate'
        self.assertFalse(self.compatible(new))

    def test_existing_route_order_change_is_rejected(self):
        new = copy.deepcopy(self.old)
        new['routes'][0], new['routes'][1] = new['routes'][1], new['routes'][0]
        self.assertFalse(self.compatible(new))


if __name__ == '__main__':
    unittest.main()
